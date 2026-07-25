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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VKClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.apiVersion = VK_API_VERSION;
  }

  async call(method, params = {}, attempt = 0) {
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

      throw new Error(`VK API Error ${code}: ${msg}`);
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

// Token helper runs instead of the server, so it must come before the check below.
if (process.argv.includes('--login')) {
  const { runLogin } = await import('./login.js');
  await runLogin().catch((error) => {
    console.error(`Login failed: ${error.message}`);
    process.exit(1);
  });
  process.exit(0);
}

const VK_ACCESS_TOKEN = process.env.VK_ACCESS_TOKEN;

if (!VK_ACCESS_TOKEN) {
  console.error('Error: VK_ACCESS_TOKEN environment variable is required.');
  console.error('Run `npx vk-mcp-server --login <APP_ID>` to obtain one interactively,');
  console.error('or see https://github.com/bulatko/vk-mcp-server#getting-vk-access-token');
  process.exit(1);
}

const vk = new VKClient(VK_ACCESS_TOKEN);

// ============================================
// TOOL DEFINITIONS
// ============================================

const tools = [
  {
    name: 'vk_users_get',
    description: 'Get information about VK users by their IDs or screen names',
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
    description: 'Search for VK users by name and other criteria',
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
    description: 'Get posts from a user or community wall',
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
    description: 'Publish a new post on a wall',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner ID' },
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
    description: 'Add a comment to a wall post',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner ID' },
        post_id: { type: 'number', description: 'Post ID' },
        message: { type: 'string', description: 'Comment text' },
      },
      required: ['owner_id', 'post_id', 'message'],
    },
  },
  {
    name: 'vk_wall_get_by_id',
    description: 'Get posts by their IDs',
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
    description: 'Edit an existing wall post',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner ID' },
        post_id: { type: 'number', description: 'Post ID to edit' },
        message: { type: 'string', description: 'New post text' },
        attachments: { type: 'string', description: 'Comma-separated attachments' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'vk_wall_delete',
    description: 'Delete a wall post',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Wall owner ID' },
        post_id: { type: 'number', description: 'Post ID to delete' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'vk_photos_upload_wall',
    description: 'Upload a photo to a community or user wall (3-step process: get upload server, upload file, save). Returns attachment string for use in wall.post/wall.edit.',
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
    description: 'Search for VK communities by name and other criteria',
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
    description: 'Get members (subscribers) of a VK community',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Community ID or short name' },
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
    description: 'Join a VK community or submit a join request if the group is closed',
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
    description: 'Get list of communities the user is a member of',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'User ID' },
        filter: { type: 'string', description: 'Filter by type' },
        fields: { type: 'string', description: 'Community fields' },
        count: { type: 'number', description: 'Number of communities' },
      },
    },
  },
  {
    name: 'vk_groups_get_by_id',
    description: 'Get community info by ID or short name',
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
    description: 'Get list of user friends',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'User ID' },
        order: { type: 'string', enum: ['hints', 'random', 'name'] },
        fields: { type: 'string', description: 'Profile fields' },
        count: { type: 'number', description: 'Number of friends' },
      },
    },
  },
  {
    name: 'vk_newsfeed_get',
    description: 'Get user newsfeed',
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
    description: 'Get community statistics (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: 'Community ID' },
        interval: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'] },
        intervals_count: { type: 'number', description: 'Number of intervals' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'vk_likes_get',
    description: 'Get list of users who liked a VK object and reaction counts. Also returns available reaction types for the object.',
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
    description: 'Get photos from albums',
    inputSchema: {
      type: 'object',
      properties: {
        owner_id: { type: 'number', description: 'Album owner ID' },
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
    const response = {
      // Text stays for clients that do not read structuredContent yet.
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
    if (OUTPUT_SCHEMAS[name]) {
      response.structuredContent = toStructuredContent(result);
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
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
