#!/usr/bin/env node
/**
 * VK MCP Server
 *
 * Model Context Protocol server для VK (ВКонтакте) API
 * Позволяет AI-ассистентам взаимодействовать с VK через стандартизированный интерфейс
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';

// Single source of truth for the version — announcing a hardcoded one drifts.
const { version: VERSION } = createRequire(import.meta.url)('../package.json');

// ============================================
// VK CLIENT
// ============================================

const VK_API_VERSION = '5.199';
// Override for tests and for users behind API mirrors/proxies
const VK_API_BASE = process.env.VK_API_BASE || 'https://api.vk.com/method';

const REQUEST_TIMEOUT_MS = Number(process.env.VK_TIMEOUT_MS) || 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// https://dev.vk.com/reference/errors
const VK_ERROR_RATE_LIMIT = 6;
const VK_ERROR_CAPTCHA = 14;

/**
 * VK error codes say what went wrong but never what to do about it, and several
 * of them look identical from the outside ("it just stopped working") while
 * having completely different fixes. These hints are what turns a support
 * question into something the user can act on themselves.
 */
const ERROR_HINTS = {
  5: 'The token is not valid any more. Get a new one with `npx vk-mcp-server --login <APP_ID>`.',
  7: 'The token lacks the permission this method needs. Re-issue it including the relevant scope (wall, photos, groups, friends or stats).',
  8:
    'This usually means the VK app that issued the token has been blocked — every token from a blocked app fails this way, however valid it looks. ' +
    'Create your own Standalone app at https://vk.com/editapp?act=create and issue a fresh token from it.',
  15: 'Access denied. The owner may have restricted this data (a private profile, or a community that hides its members), or the token belongs to an account without the rights to see it.',
  17: 'VK wants the account validated. Sign in to vk.com in a browser, complete the check, then retry.',
  18: 'That user is deleted or banned.',
  27: 'Community authorisation failed. Create a token under Manage → API usage → Access tokens in the community you want to act as.',
  28:
    'This method needs a user or community token; a service token cannot call it. ' +
    'Run `npx vk-mcp-server --login <APP_ID>` for a user token, or create a community token under Manage → API usage → Access tokens.',
  29: 'The per-method quota for this token is used up. Wait, or spread the calls out.',
  100: 'VK rejected one of the parameters. Check IDs and required arguments — community IDs are positive here, wall owner IDs are negative.',
  113: 'No such user ID.',
  203: 'Access to that community is denied for this token.',
  214: 'Posting to that wall is denied — the token needs the wall scope and the account needs the right to post there.',
  1051:
    'A service token cannot call this method. ' +
    'Use a user token (`npx vk-mcp-server --login <APP_ID>`) or a community token, depending on whose data you are after.',
};

/**
 * Raised on the first tool call when no token is configured. The server itself
 * starts fine without one — see the note above the startup check — so this is
 * where a missing token has to be explained, and it has to be explained to
 * whoever is reading the chat, not to a terminal nobody is watching.
 */
const NO_TOKEN_MESSAGE =
  'No VK token configured. This server needs VK_ACCESS_TOKEN set in its environment. ' +
  'Run `npx vk-mcp-server --login <APP_ID>` to obtain one through VK ID in your browser, ' +
  'or follow https://github.com/bulatko/vk-mcp-server/blob/main/docs/SETUP.md. ' +
  'Listing tools works without a token; calling them does not.';

/**
 * Subcodes override the code-level hint where they mean something more
 * specific. 1130 is the one that catches people out: the token is valid, the
 * account is fine, and it still fails — because VK bound it to the IP that
 * authorised, and this server is somewhere else.
 */
const ERROR_SUBCODE_HINTS = {
  1130:
    'VK bound this token to the IP address that authorised it, and requests are now coming from a different one. ' +
    'This happens when the server runs on one machine (a VPS, say) and the browser that signed in is on another. ' +
    'Either obtain the token from the machine that will run the server, or use a community token — those are created ' +
    'in the community settings and are not tied to a browser session.',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VKClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.apiVersion = VK_API_VERSION;
  }

  async call(method, params = {}, attempt = 0) {
    // Every path to VK goes through here, including the two-step photo upload,
    // so one check covers the whole tool surface.
    if (!this.accessToken) throw new Error(NO_TOKEN_MESSAGE);

    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const body = new URLSearchParams({
      ...clean,
      access_token: this.accessToken,
      v: this.apiVersion,
    });

    let response;
    try {
      response = await fetch(`${VK_API_BASE}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`VK API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`);
      }
      throw err;
    }

    if (!response.ok) {
      throw new Error(`VK API HTTP ${response.status} ${response.statusText} for ${method}`);
    }

    const data = await response.json();

    if (data.error) {
      const { error_code: code, error_msg: msg } = data.error;

      // 6 = too many requests per second. VK's limit is low (a few calls per
      // second), so a burst of tool calls hits it routinely; back off and retry
      // rather than surfacing a failure the caller can do nothing about.
      if (code === VK_ERROR_RATE_LIMIT && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        return this.call(method, params, attempt + 1);
      }

      if (code === VK_ERROR_CAPTCHA) {
        throw new Error(
          `VK API Error ${code}: ${msg}. VK is asking for a captcha, which this ` +
            'server cannot solve. Retry later, or slow down the request rate.'
        );
      }

      const hint = ERROR_SUBCODE_HINTS[data.error.error_subcode] || ERROR_HINTS[code];
      throw new Error(`VK API Error ${code}: ${msg}${hint ? ` — ${hint}` : ''}`);
    }

    return data.response;
  }

  // Users
  usersGet(params) { return this.call('users.get', params); }
  usersSearch(params) { return this.call('users.search', params); }

  // Wall
  wallGet(params) { return this.call('wall.get', params); }
  wallGetById(params) { return this.call('wall.getById', params); }
  wallPost(params) { return this.call('wall.post', params); }
  wallEdit(params) { return this.call('wall.edit', params); }
  wallDelete(params) { return this.call('wall.delete', params); }
  wallCreateComment(params) { return this.call('wall.createComment', params); }

  // Groups
  groupsGet(params) { return this.call('groups.get', { ...params, extended: 1 }); }
  groupsGetById(params) { return this.call('groups.getById', params); }
  groupsGetMembers(params) { return this.call('groups.getMembers', params); }
  groupsSearch(params) { return this.call('groups.search', params); }
  groupsJoin(params) { return this.call('groups.join', params); }

  // Friends
  friendsGet(params) { return this.call('friends.get', params); }

  // Newsfeed
  newsfeedGet(params) { return this.call('newsfeed.get', params); }

  // Stats
  statsGet(params) { return this.call('stats.get', params); }

  // Likes
  likesGetList(params) { return this.call('likes.getList', params); }

  // Photos
  photosGet(params) { return this.call('photos.get', params); }
  photosGetWallUploadServer(params) { return this.call('photos.getWallUploadServer', params); }
  photosSaveWallPhoto(params) { return this.call('photos.saveWallPhoto', params); }

  async uploadPhoto(uploadUrl, imageSource) {
    let blob;
    let filename = 'photo.jpg';

    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
      const resp = await fetch(imageSource);
      if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
      const contentType = resp.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
      filename = `photo.${ext}`;
      blob = await resp.blob();
    } else {
      const { readFile } = await import('node:fs/promises');
      const buffer = await readFile(imageSource);
      const ext = imageSource.split('.').pop() || 'jpg';
      filename = `photo.${ext}`;
      blob = new Blob([buffer], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
    }

    const formData = new FormData();
    formData.append('photo', blob, filename);

    const resp = await fetch(uploadUrl, { method: 'POST', body: formData });
    const data = await resp.json();

    if (!data.photo || data.photo === '[]') {
      throw new Error('Photo upload failed: empty response from VK upload server');
    }

    return data;
  }
}

// ============================================
// SETUP
// ============================================

// Subcommands run instead of the server, so they come before the token check.
if (process.argv.includes('--login')) {
  const { runLogin } = await import('./login.js');
  await runLogin().catch((error) => {
    console.error(`Login failed: ${error.message}`);
    process.exit(1);
  });
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const { runCheck } = await import('./check.js');
  await runCheck().catch((error) => {
    console.error(`Check failed: ${error.message}`);
    process.exit(1);
  });
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(`vk-mcp-server ${VERSION} — MCP server for the VK API

Usage:
  npx vk-mcp-server                 run the MCP server (needs VK_ACCESS_TOKEN to call tools)
  npx vk-mcp-server --login <APP_ID>  get a token through VK ID in your browser
  npx vk-mcp-server --check         report what your token is and what it can do
  npx vk-mcp-server --help          this message

Environment:
  VK_ACCESS_TOKEN   required for tool calls; the server starts and lists tools without it
  VK_TIMEOUT_MS     abort a VK request after this many ms (default 30000)
  VK_API_BASE       point at an API mirror or proxy
  VK_LOGIN_PORT     local port used by --login (default 8790)

Docs: https://github.com/bulatko/vk-mcp-server`);
  process.exit(0);
}

// A missing token used to be fatal here. It cannot be: discovery has to work
// without credentials. Registries introspect the server by starting it with an
// empty environment and reading tools/list — refusing to boot made us look like
// a server with no tools at all. Clients hit the same wall from the other side:
// a user who installs the bundle before pasting a token sees the process die
// with a message on a stream no chat window shows. So we start regardless, and
// the first tool call is what explains the missing token, in the chat.
const VK_ACCESS_TOKEN = process.env.VK_ACCESS_TOKEN;

const vk = new VKClient(VK_ACCESS_TOKEN);

// ============================================
// TOOL DEFINITIONS
// ============================================

const tools = [
  {
    name: 'vk_users_get',
    title: 'Get user profiles',
    description: 'Look up VK users by numeric ID or short name (e.g. durov). Use this to resolve a name to an ID before calling other tools, or to check whether a profile is closed.',
    inputSchema: {
      type: 'object',
      properties: {
        user_ids: { type: 'string', description: 'Comma-separated user IDs or screen names' },
        fields: { type: 'string', description: 'Profile fields to return' },
      },
    },
  },
  {
    name: 'vk_users_search',
    title: 'Search users',
    description: 'Find VK users by name, optionally narrowed by city, country, sex or age. Returns matches with a total count; page through them with offset.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query (name or keywords)' },
        count: { type: 'number', description: 'Number of results (max 1000)' },
        offset: { type: 'number', description: 'Offset for pagination' },
        fields: { type: 'string', description: 'Additional profile fields to return' },
        city: { type: 'number', description: 'City ID to filter by' },
        country: { type: 'number', description: 'Country ID to filter by' },
        sex: { type: 'number', description: 'Sex filter: 1 — female, 2 — male', enum: [1, 2] },
        age_from: { type: 'number', description: 'Minimum age' },
        age_to: { type: 'number', description: 'Maximum age' },
      },
      required: ['q'],
    },
  },
  {
    name: 'vk_wall_get',
    title: 'Read a wall',
    description: 'Read posts from a user or community wall, newest first. Pass domain for a short address (durov) or owner_id for a numeric one — negative for a community, positive for a person. Each post carries its likes, reposts, comments and views.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner ID (negative for community)' },
        domain: { type: 'string', description: 'Short address of user or community' },
        count: { type: 'number', description: 'Number of posts (1-100)' },
        offset: { type: 'number', description: 'Offset for pagination' },
        filter: { type: 'string', description: 'Filter: all, owner, others, postponed, suggests', enum: ['all', 'owner', 'others', 'postponed', 'suggests'] },
      },
    },
  },
  {
    name: 'vk_wall_post',
    title: 'Publish a post',
    description: 'Publish a post on a wall. To post in a community, set owner_id to the community ID with a minus sign (-123) and from_group true, otherwise it appears as your personal post on the community wall. Attach media with the attachment string that vk_photos_upload_wall returns. Returns the new post_id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner: a community as a negative number (-123), a person as a positive one. Defaults to the token owner.' },
        message: { type: 'string', description: 'Post text content' },
        from_group: { type: 'boolean', description: 'Post on behalf of community' },
        attachments: { type: 'string', description: 'Comma-separated attachments (e.g. photo123_456,link)' },
        publish_date: { type: 'number', description: 'Unix timestamp for scheduled post (must be within 2 weeks)' },
        guid: { type: 'string', description: 'Unique identifier to prevent duplicate posts' },
      },
      required: ['message'],
    },
  },
  {
    name: 'vk_wall_create_comment',
    title: 'Comment on a post',
    description: 'Add a comment to a post. owner_id is negative for a community. Returns the new comment_id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner: a community as a negative number (-123), a person as a positive one. Defaults to the token owner.' },
        post_id: { type: 'number', description: 'Post ID' },
        message: { type: 'string', description: 'Comment text' },
      },
      required: ['owner_id', 'post_id', 'message'],
    },
  },
  {
    name: 'vk_wall_get_by_id',
    title: 'Get specific posts',
    description: 'Fetch particular posts by their full IDs in {owner_id}_{post_id} form, e.g. -1_340393. Use it to re-read a post you already know about, such as one you just published.',
    inputSchema: {
      type: 'object',
      properties: {
        posts: { type: 'string', description: 'Comma-separated post IDs in format {owner_id}_{post_id} (e.g. -123_456)' },
        fields: { type: 'string', description: 'Additional profile fields to return' },
      },
      required: ['posts'],
    },
  },
  {
    name: 'vk_wall_edit',
    title: 'Edit a post',
    description: 'Replace the text or attachments of an existing post. owner_id is negative for a community. Editing overwrites the previous content, so pass the full new text rather than an addition.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner: a community as a negative number (-123), a person as a positive one. Defaults to the token owner.' },
        post_id: { type: 'number', description: 'Post ID to edit' },
        message: { type: 'string', description: 'New post text' },
        attachments: { type: 'string', description: 'Comma-separated attachments' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'vk_wall_delete',
    title: 'Delete a post',
    description: 'Delete a post from a wall. owner_id is negative for a community. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner: a community as a negative number (-123), a person as a positive one. Defaults to the token owner.' },
        post_id: { type: 'number', description: 'Post ID to delete' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'vk_photos_upload_wall',
    title: 'Upload a photo for a post',
    description: 'Upload a photo so it can be attached to a post. Takes a URL or a local file path, runs VK\'s three-step upload, and returns an attachment string like photo-1_2 to pass to vk_wall_post or vk_wall_edit. group_id is positive here, without the minus sign.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: 'Community ID (positive number, without minus sign)' },
        image: { type: 'string', description: 'Image URL (http/https) or absolute local file path' },
        caption: { type: 'string', description: 'Photo caption' },
      },
      required: ['image'],
    },
  },
  {
    name: 'vk_groups_search',
    title: 'Search communities',
    description: 'Find communities by keyword, optionally narrowed by type, country, city or sort order. Returns matches with a total count.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (max 1000)' },
        offset: { type: 'number', description: 'Offset for pagination' },
        fields: { type: 'string', description: 'Additional community fields to return' },
        type: { type: 'string', description: 'Community type: group, page or event', enum: ['group', 'page', 'event'] },
        country_id: { type: 'number', description: 'Country ID to filter by' },
        city_id: { type: 'number', description: 'City ID to filter by' },
        future: { type: 'number', description: 'Filter future events: 1 — only future events', enum: [0, 1] },
        sort: { type: 'number', description: 'Sort order: 0 — default, 1 — by speed, 6 — by likes', enum: [0, 1, 6] },
      },
      required: ['q'],
    },
  },
  {
    name: 'vk_groups_get_members',
    title: 'List community members',
    description: 'List the members of a community. Returns bare user IDs unless you ask for fields, in which case it returns profiles. Many communities hide their member list, which comes back as an access error rather than an empty list.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Community ID (positive, no minus sign) or its short name, e.g. apiclub.' },
        count: { type: 'number', description: 'Number of members to return (max 1000)' },
        offset: { type: 'number', description: 'Offset for pagination' },
        fields: { type: 'string', description: 'Additional profile fields to return (e.g. photo_200,online,sex,city)' },
        filter: { type: 'string', description: 'Filter: managers, editors, mods, advertisers, friends, unsure', enum: ['managers', 'editors', 'mods', 'advertisers', 'friends', 'unsure'] },
        sort: { type: 'string', description: 'Sort order: id_asc, id_desc, time_asc, time_desc', enum: ['id_asc', 'id_desc', 'time_asc', 'time_desc'] },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'vk_groups_join',
    title: 'Join a community',
    description: 'Join a community as the token owner, or send a join request if it is closed. group_id is positive here, without the minus sign.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: 'Community ID (positive number, without minus sign)' },
        not_sure: { type: 'number', description: 'For events only: 1 — "maybe attending", 0 — confirmed', enum: [0, 1] },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'vk_groups_get',
    title: 'List your communities',
    description: 'List the communities the token owner belongs to. Needs a user token — a community or service token cannot answer this.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'User ID. Defaults to the token owner.' },
        filter: { type: 'string', description: 'Filter by type' },
        fields: { type: 'string', description: 'Community fields' },
        count: { type: 'number', description: 'Number of communities' },
      },
    },
  },
  {
    name: 'vk_groups_get_by_id',
    title: 'Get community info',
    description: 'Look up communities by numeric ID or short name (e.g. apiclub). Use it to resolve a name to an ID, or to read the description, member count and type before deciding what to do with it.',
    inputSchema: {
      type: 'object',
      properties: {
        group_ids: { type: 'string', description: 'Comma-separated group IDs' },
        fields: { type: 'string', description: 'Community fields' },
      },
    },
  },
  {
    name: 'vk_friends_get',
    title: 'List friends',
    description: 'List a user\'s friends. Returns bare IDs unless you ask for fields. Needs a user token, and only works for profiles that expose their friend list.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'User ID. Defaults to the token owner.' },
        order: { type: 'string', enum: ['hints', 'random', 'name'] },
        fields: { type: 'string', description: 'Profile fields' },
        count: { type: 'number', description: 'Number of friends' },
      },
    },
  },
  {
    name: 'vk_newsfeed_get',
    title: 'Read your newsfeed',
    description: 'Read the token owner\'s own newsfeed. Needs a user token — this is the feed of the account the token belongs to, not a public one.',
    inputSchema: {
      type: 'object',
      properties: {
        filters: { type: 'string', description: 'Filter by type: post, photo, video' },
        count: { type: 'number', description: 'Number of items' },
        start_from: { type: 'string', description: 'Pagination cursor' },
      },
    },
  },
  {
    name: 'vk_stats_get',
    title: 'Community statistics',
    description: 'Read a community\'s statistics by period: reach, visitors and activity. The token owner must be an administrator of that community, otherwise VK denies access.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: 'Community ID, positive and without the minus sign.' },
        interval: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'] },
        intervals_count: { type: 'number', description: 'Number of intervals' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'vk_likes_get',
    title: 'See who reacted',
    description: 'List the users who liked or reacted to an object — a post, comment, photo or video — with counts per reaction. owner_id is negative for a community; item_id is the post or object ID.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Object type',
          enum: ['post', 'comment', 'photo', 'audio', 'video', 'note', 'photo_comment', 'video_comment', 'topic_comment', 'sitepage'],
        },
        owner_id: { type: 'number', description: 'Owner ID of the object (negative for community)' },
        item_id: { type: 'number', description: 'Object ID' },
        reaction_id: {
          type: 'number',
          description: 'Filter by reaction: 0 — like ❤️, 1 — laugh 😂, 2 — wow 😮, 3 — admiration 🔥, 4 — angry 😡, 5 — sad 😢',
          enum: [0, 1, 2, 3, 4, 5],
        },
        count: { type: 'number', description: 'Number of users to return (max 1000)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
      required: ['type', 'item_id'],
    },
  },
  {
    name: 'vk_photos_get',
    title: 'Get photos',
    description: 'List photos from an album. album_id accepts wall, profile or saved as well as a numeric album ID. owner_id is negative for a community.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Album owner: negative for a community, positive for a person.' },
        album_id: { type: 'string', description: 'Album ID or: wall, profile, saved' },
        count: { type: 'number', description: 'Number of photos' },
      },
    },
  },
];

// Output schemas. A tool that declares one must return structuredContent that
// validates against it, so these stay deliberately loose: VK adds fields over
// time and a strict schema would reject perfectly good responses. They describe
// the shape the model can rely on, not every field VK might send.
const listOutput = (itemsDescription) => ({
  type: 'object',
  properties: {
    count: {
      type: 'number',
      description: 'Total number of matches on VK, which is usually larger than the returned page',
    },
    items: { type: 'array', description: itemsDescription, items: { type: 'object' } },
    pagination: {
      type: 'object',
      description:
        'Where this page sits in the whole result. Call the tool again with offset set to next_offset to continue; when next_offset is null there is nothing left to fetch.',
      properties: {
        total: { type: 'number', description: 'How many matches VK has in total' },
        returned: { type: 'number', description: 'How many came back on this page' },
        offset: { type: 'number', description: 'The offset this page started at' },
        next_offset: {
          type: ['number', 'null'],
          description: 'Offset for the next page, or null when this page is the last one',
        },
        next_from: {
          type: 'string',
          description: 'Cursor for the next page, on the tools that page by cursor rather than offset',
        },
      },
    },
  },
  required: ['items'],
});

const successOutput = {
  type: 'object',
  properties: { success: { type: 'boolean', description: 'Whether VK accepted the change' } },
  required: ['success'],
};

const OUTPUT_SCHEMAS = {
  vk_users_get: listOutput('User profiles'),
  vk_users_search: listOutput('Matching user profiles'),
  vk_wall_get: listOutput('Wall posts, newest first'),
  vk_wall_get_by_id: listOutput('The requested posts'),
  vk_groups_get: listOutput('Communities the user belongs to'),
  vk_groups_search: listOutput('Matching communities'),
  vk_groups_get_members: listOutput('Member IDs, or profiles when fields are requested'),
  vk_friends_get: listOutput('Friend IDs, or profiles when fields are requested'),
  vk_newsfeed_get: listOutput('Newsfeed entries'),
  vk_likes_get: listOutput('Users who reacted to the object'),
  vk_photos_get: listOutput('Photos in the album'),
  vk_stats_get: listOutput('One entry per statistics period'),
  vk_groups_get_by_id: {
    type: 'object',
    properties: { groups: { type: 'array', description: 'Community profiles', items: { type: 'object' } } },
  },
  vk_wall_post: {
    type: 'object',
    properties: { post_id: { type: 'number', description: 'ID of the published post' } },
    required: ['post_id'],
  },
  vk_wall_create_comment: {
    type: 'object',
    properties: { comment_id: { type: 'number', description: 'ID of the created comment' } },
    required: ['comment_id'],
  },
  vk_photos_upload_wall: {
    type: 'object',
    properties: {
      attachment: {
        type: 'string',
        description: 'Attachment string such as photo-1_2, ready to pass to vk_wall_post',
      },
      id: { type: 'number', description: 'Photo ID' },
      owner_id: { type: 'number', description: 'Owner of the uploaded photo' },
    },
    required: ['attachment'],
  },
  vk_wall_edit: successOutput,
  vk_wall_delete: successOutput,
  vk_groups_join: successOutput,
};

// Per-area icons (SEP-973). Inline SVG data URIs keep them dependency-free and
// offline; they use currentColor so they follow the client's light or dark theme.
const icon = (paths) => [
  {
    src:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
      ),
    mimeType: 'image/svg+xml',
    sizes: ['any'],
  },
];

const ICONS = {
  user: icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
  wall: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>'),
  group: icon('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15.5 20c0-2.2 1.5-4 3.5-4s2 1 2 4"/>'),
  photo: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 16-5-5-4 4-2-2-4 4"/>'),
  chart: icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  heart: icon('<path d="M12 20s-7-4.5-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.5 12 20 12 20z"/>'),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
};

const TOOL_ICONS = {
  vk_users_get: ICONS.user,
  vk_users_search: ICONS.search,
  vk_friends_get: ICONS.user,
  vk_wall_get: ICONS.wall,
  vk_wall_get_by_id: ICONS.wall,
  vk_wall_post: ICONS.wall,
  vk_wall_edit: ICONS.wall,
  vk_wall_delete: ICONS.wall,
  vk_wall_create_comment: ICONS.wall,
  vk_newsfeed_get: ICONS.wall,
  vk_groups_get: ICONS.group,
  vk_groups_get_by_id: ICONS.group,
  vk_groups_get_members: ICONS.group,
  vk_groups_join: ICONS.group,
  vk_groups_search: ICONS.search,
  vk_photos_get: ICONS.photo,
  vk_photos_upload_wall: ICONS.photo,
  vk_stats_get: ICONS.chart,
  vk_likes_get: ICONS.heart,
};

// Tools that change something on VK, and whether the change destroys or
// overwrites existing data. Everything not listed here is read-only.
const WRITING_TOOLS = {
  vk_wall_post: { destructive: false },
  vk_wall_edit: { destructive: true },
  vk_wall_delete: { destructive: true },
  vk_wall_create_comment: { destructive: false },
  vk_photos_upload_wall: { destructive: false },
  vk_groups_join: { destructive: false, idempotent: true },
};

// MCP annotations let a client tell reads from writes — so it can auto-approve
// a wall lookup while still asking before deleting a post. Derived from one
// table instead of repeated per tool, so a new tool is read-only by default.
for (const tool of tools) {
  if (OUTPUT_SCHEMAS[tool.name]) tool.outputSchema = OUTPUT_SCHEMAS[tool.name];
  if (TOOL_ICONS[tool.name]) tool.icons = TOOL_ICONS[tool.name];

  const write = WRITING_TOOLS[tool.name];
  tool.annotations = {
    readOnlyHint: !write,
    destructiveHint: write ? write.destructive : false,
    idempotentHint: write ? Boolean(write.idempotent) : true,
    openWorldHint: true, // every tool calls the VK API
  };
}

// ============================================
// TOOL HANDLERS
// ============================================

async function handleToolCall(name, args) {
  try {
    let result;

    switch (name) {
      case 'vk_users_get':
        result = await vk.usersGet({
          user_ids: args.user_ids,
          fields: args.fields ?? 'photo_200,online,status',
        });
        break;

      case 'vk_users_search':
        result = await vk.usersSearch({
          q: args.q,
          count: args.count ?? 20,
          offset: args.offset,
          fields: args.fields ?? 'photo_200,online,status',
          city: args.city,
          country: args.country,
          sex: args.sex,
          age_from: args.age_from,
          age_to: args.age_to,
        });
        break;

      case 'vk_wall_get':
        result = await vk.wallGet({
          owner_id: args.owner_id,
          domain: args.domain,
          count: args.count ?? 20,
          offset: args.offset,
          filter: args.filter,
        });
        break;

      case 'vk_wall_post':
        result = await vk.wallPost({
          owner_id: args.owner_id,
          message: args.message,
          from_group: args.from_group ? 1 : 0,
          attachments: args.attachments,
          publish_date: args.publish_date,
          guid: args.guid,
        });
        break;

      case 'vk_wall_create_comment':
        result = await vk.wallCreateComment({
          owner_id: args.owner_id,
          post_id: args.post_id,
          message: args.message,
        });
        break;

      case 'vk_wall_get_by_id':
        result = await vk.wallGetById({
          posts: args.posts,
          fields: args.fields,
        });
        break;

      case 'vk_wall_edit':
        result = await vk.wallEdit({
          owner_id: args.owner_id,
          post_id: args.post_id,
          message: args.message,
          attachments: args.attachments,
        });
        break;

      case 'vk_wall_delete':
        result = await vk.wallDelete({
          owner_id: args.owner_id,
          post_id: args.post_id,
        });
        break;

      case 'vk_likes_get':
        result = await vk.likesGetList({
          type: args.type,
          owner_id: args.owner_id,
          item_id: args.item_id,
          reaction_id: args.reaction_id,
          count: args.count ?? 100,
          offset: args.offset,
        });
        break;

      case 'vk_photos_upload_wall': {
        const uploadServer = await vk.photosGetWallUploadServer({
          group_id: args.group_id,
        });
        const uploadResult = await vk.uploadPhoto(uploadServer.upload_url, args.image);
        const saved = await vk.photosSaveWallPhoto({
          group_id: args.group_id,
          server: uploadResult.server,
          photo: uploadResult.photo,
          hash: uploadResult.hash,
          caption: args.caption,
        });
        const photo = saved[0];
        result = {
          ...photo,
          attachment: `photo${photo.owner_id}_${photo.id}`,
        };
        break;
      }

      case 'vk_groups_search':
        result = await vk.groupsSearch({
          q: args.q,
          count: args.count ?? 20,
          offset: args.offset,
          fields: args.fields,
          type: args.type,
          country_id: args.country_id,
          city_id: args.city_id,
          future: args.future,
          sort: args.sort,
        });
        break;

      case 'vk_groups_get_members':
        result = await vk.groupsGetMembers({
          group_id: args.group_id,
          count: args.count ?? 100,
          offset: args.offset,
          fields: args.fields,
          filter: args.filter,
          sort: args.sort ?? 'id_asc',
        });
        break;

      case 'vk_groups_join':
        result = await vk.groupsJoin({
          group_id: args.group_id,
          not_sure: args.not_sure,
        });
        break;

      case 'vk_groups_get':
        result = await vk.groupsGet({
          user_id: args.user_id,
          filter: args.filter,
          fields: args.fields ?? 'description,members_count',
          count: args.count ?? 100,
        });
        break;

      case 'vk_groups_get_by_id':
        result = await vk.groupsGetById({
          group_ids: args.group_ids,
          fields: args.fields ?? 'description,members_count',
        });
        break;

      case 'vk_friends_get':
        result = await vk.friendsGet({
          user_id: args.user_id,
          order: args.order,
          fields: args.fields ?? 'photo_200,online',
          count: args.count ?? 100,
        });
        break;

      case 'vk_newsfeed_get':
        result = await vk.newsfeedGet({
          filters: args.filters ?? 'post',
          count: args.count ?? 20,
          start_from: args.start_from,
        });
        break;

      case 'vk_stats_get':
        result = await vk.statsGet({
          group_id: args.group_id,
          interval: args.interval ?? 'day',
          intervals_count: args.intervals_count ?? 7,
        });
        break;

      case 'vk_photos_get':
        result = await vk.photosGet({
          owner_id: args.owner_id,
          album_id: args.album_id ?? 'wall',
          count: args.count ?? 50,
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return result;
  } catch (error) {
    // Rethrow so the caller can flag it as a tool execution error. Swallowing it
    // into a plain string made every failure look like a successful result.
    throw error;
  }
}

/**
 * VK answers with an object for most methods, a bare array for a few
 * (users.get, stats.get) and the number 1 for "it worked" (wall.delete,
 * groups.join). structuredContent has to be an object, so normalise.
 */
/**
 * VK answers a list request with a total and one page of items, and nothing
 * that says how to reach the next one. The model is left to either stop at the
 * first page believing it has everything, or invent an offset. This states the
 * arithmetic: what came back, where it started, and the offset that continues
 * from here — null when the page is the last.
 */
function paginationFor(args, result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.items)) return null;

  // The newsfeed pages by cursor, not by offset: VK hands back the token for
  // the next page and an offset means nothing there.
  if (result.next_from) return { returned: result.items.length, next_from: result.next_from };

  if (typeof result.count !== 'number') return null;

  const offset = Number(args.offset) || 0;
  const returned = result.items.length;
  const next = offset + returned;
  return {
    total: result.count,
    returned,
    offset,
    // A page that came back empty means VK has nothing more to give, whatever
    // the total says — some endpoints count matches the token cannot read.
    next_offset: returned > 0 && next < result.count ? next : null,
  };
}

function toStructuredContent(result) {
  if (result === null || result === undefined) return {};
  if (Array.isArray(result)) return { items: result };
  if (typeof result !== 'object') return { success: Boolean(result) };
  return result;
}

// ============================================
// PROMPTS
// ============================================

// Prompts are the entry points a user sees in their client. They exist so that
// someone who has never read the tool list can still get something useful out
// of the server on the first try.
const prompts = [
  {
    name: 'community_digest',
    title: 'Digest a VK community',
    description: 'Summarise what a community has been posting lately, with themes and standout posts.',
    arguments: [
      { name: 'community', description: 'Short address or numeric ID, e.g. apiclub', required: true },
      { name: 'count', description: 'How many recent posts to read (default 20)', required: false },
    ],
    build: ({ community, count = '20' }) =>
      `Read the last ${count} posts from the VK community "${community}" and write a digest.\n\n` +
      `Use vk_groups_get_by_id to identify the community, then vk_wall_get with domain="${community}" ` +
      `and count=${count}.\n\n` +
      'Cover: what the community is about, the recurring themes across these posts, ' +
      'the two or three posts that stand out and why, and the posting cadence. ' +
      'Quote sparingly and link posts as https://vk.com/wall{owner_id}_{post_id}.',
  },
  {
    name: 'engagement_report',
    title: 'Analyse engagement',
    description: 'Find which posts resonated and what they have in common.',
    arguments: [
      { name: 'community', description: 'Short address or numeric ID', required: true },
      { name: 'count', description: 'How many recent posts to consider (default 50)', required: false },
    ],
    build: ({ community, count = '50' }) =>
      `Analyse engagement for the VK community "${community}".\n\n` +
      `Fetch the last ${count} posts with vk_wall_get (domain="${community}", count=${count}). ` +
      'Each post carries likes, reposts, comments and views counts — rank by likes and by ' +
      'comments separately, since they measure different things.\n\n' +
      'Report: the top five posts by each measure, what the winners have in common ' +
      '(format, length, media, time of day, topic), what the weakest posts share, and ' +
      'two concrete recommendations. Base every claim on the numbers you fetched, not on assumptions.',
  },
  {
    name: 'audience_snapshot',
    title: 'Describe a community audience',
    description: 'Sample the members of a community and describe who they are.',
    arguments: [
      { name: 'community', description: 'Short address or numeric ID', required: true },
      { name: 'sample', description: 'How many members to sample (default 200)', required: false },
    ],
    build: ({ community, sample = '200' }) =>
      `Describe the audience of the VK community "${community}".\n\n` +
      `Use vk_groups_get_by_id for the size and topic, then vk_groups_get_members with ` +
      `group_id="${community}", count=${sample} and fields="sex,city,bdate,last_seen" to sample members.\n\n` +
      'Report the split by sex, the most common cities, a rough age picture from bdate where ' +
      'present, and how many look active from last_seen. ' +
      `State explicitly that this is a sample of ${sample}, not the whole audience, and note ` +
      'that VK hides some fields, so percentages are of the members who exposed that field.',
  },
  {
    name: 'publish_post',
    title: 'Publish a post to a community',
    description: 'Draft a post, show it for approval, and publish it once you say so.',
    arguments: [
      { name: 'community', description: 'Community short address or numeric ID', required: true },
      { name: 'about', description: 'What the post should say', required: true },
      { name: 'image', description: 'Optional image URL or local file path', required: false },
    ],
    build: ({ community, about, image }) =>
      `Write and publish a VK post for the community "${community}" about: ${about}\n\n` +
      `First use vk_groups_get_by_id with group_ids="${community}" to get its numeric ID, and ` +
      'read the last few posts with vk_wall_get so the new one matches the tone and length ' +
      'that community actually uses.\n\n' +
      (image
        ? `Upload the image with vk_photos_upload_wall (group_id = the positive community ID, image="${image}") ` +
          'and keep the attachment string it returns.\n\n'
        : '') +
      'Then show me the draft and wait for my approval — do not publish first and ask after. ' +
      'Once I approve, publish with vk_wall_post using owner_id = minus the community ID ' +
      '(a community is negative there) and from_group=true, so it appears as the community' +
      (image ? ', and attachments = the string from the upload step' : '') +
      '. Finish by giving me the link: https://vk.com/wall{owner_id}_{post_id}.',
  },
  {
    name: 'find_communities',
    title: 'Find communities on a topic',
    description: 'Search VK communities on a topic and compare the candidates.',
    arguments: [
      { name: 'topic', description: 'What to search for, e.g. indie music', required: true },
      { name: 'count', description: 'How many candidates to compare (default 10)', required: false },
    ],
    build: ({ topic, count = '10' }) =>
      `Find VK communities about "${topic}".\n\n` +
      `Search with vk_groups_search (q="${topic}", count=${count}), then pull details for the ` +
      'candidates with vk_groups_get_by_id using fields="description,members_count,activity".\n\n' +
      'Present a table of name, members, activity and a one-line description, ordered by size. ' +
      'Then say which two or three are worth following and why. ' +
      'Flag any that look dormant or spammy rather than silently including them.',
  },
];

// ============================================
// SERVER SETUP
// ============================================

const server = new Server(
  { name: 'vk-mcp-server', version: VERSION },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: prompts.map(({ build, ...prompt }) => prompt),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = prompts.find((p) => p.name === request.params.name);
  if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);

  const args = request.params.arguments || {};
  const missing = (prompt.arguments || [])
    .filter((a) => a.required && !args[a.name])
    .map((a) => a.name);
  if (missing.length) {
    throw new Error(`Missing required argument(s) for ${prompt.name}: ${missing.join(', ')}`);
  }

  return {
    description: prompt.description,
    messages: [
      { role: 'user', content: { type: 'text', text: prompt.build(args) } },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args || {});
    const pagination = paginationFor(args || {}, result);
    const payload = pagination ? { ...result, pagination } : result;
    const response = {
      // Text stays for clients that do not read structuredContent yet.
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
    if (OUTPUT_SCHEMAS[name]) {
      response.structuredContent = toStructuredContent(payload);
    }
    return response;
  } catch (error) {
    // A failed VK call is a tool execution error, not a protocol error: the
    // model sees it, can explain it or retry with different arguments. Without
    // isError the client treats the message as a successful result.
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VK MCP Server running on stdio');
  if (!VK_ACCESS_TOKEN) {
    console.error('No VK_ACCESS_TOKEN set — tools are listed but will fail when called.');
    console.error('Get one with `npx vk-mcp-server --login <APP_ID>`.');
  }
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
