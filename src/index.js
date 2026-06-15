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
} from '@modelcontextprotocol/sdk/types.js';

// ============================================
// VK CLIENT
// ============================================

const VK_API_VERSION = '5.199';
const VK_API_BASE = 'https://api.vk.com/method';

class VKClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.apiVersion = VK_API_VERSION;
  }

  async call(method, params = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const body = new URLSearchParams({
      ...clean,
      access_token: this.accessToken,
      v: this.apiVersion,
    });

    const response = await fetch(`${VK_API_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`VK API Error ${data.error.error_code}: ${data.error.error_msg}`);
    }

    return data.response;
  }

  // Users
  usersGet(params) { return this.call('users.get', params); }

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

  // Friends
  friendsGet(params) { return this.call('friends.get', params); }

  // Newsfeed
  newsfeedGet(params) { return this.call('newsfeed.get', params); }

  // Stats
  statsGet(params) { return this.call('stats.get', params); }

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

const VK_ACCESS_TOKEN = process.env.VK_ACCESS_TOKEN;

if (!VK_ACCESS_TOKEN) {
  console.error('Error: VK_ACCESS_TOKEN environment variable is required');
  console.error('Get your token at: https://vk.com/dev');
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
          fields: args.fields || 'photo_200,online,status',
        });
        break;

      case 'vk_wall_get':
        result = await vk.wallGet({
          owner_id: args.owner_id,
          domain: args.domain,
          count: args.count || 20,
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
          count: args.count || 20,
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
          count: args.count || 1000,
          offset: args.offset,
          fields: args.fields,
          filter: args.filter,
          sort: args.sort || 'id_asc',
        });
        break;

      case 'vk_groups_get':
        result = await vk.groupsGet({
          user_id: args.user_id,
          filter: args.filter,
          fields: args.fields || 'description,members_count',
          count: args.count || 100,
        });
        break;

      case 'vk_groups_get_by_id':
        result = await vk.groupsGetById({
          group_ids: args.group_ids,
          fields: args.fields || 'description,members_count',
        });
        break;

      case 'vk_friends_get':
        result = await vk.friendsGet({
          user_id: args.user_id,
          order: args.order,
          fields: args.fields || 'photo_200,online',
          count: args.count || 100,
        });
        break;

      case 'vk_newsfeed_get':
        result = await vk.newsfeedGet({
          filters: args.filters || 'post',
          count: args.count || 20,
          start_from: args.start_from,
        });
        break;

      case 'vk_stats_get':
        result = await vk.statsGet({
          group_id: args.group_id,
          interval: args.interval || 'day',
          intervals_count: args.intervals_count || 7,
        });
        break;

      case 'vk_photos_get':
        result = await vk.photosGet({
          owner_id: args.owner_id,
          album_id: args.album_id || 'wall',
          count: args.count || 50,
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return JSON.stringify(result, null, 2);
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

// ============================================
// SERVER SETUP
// ============================================

const server = new Server(
  { name: 'vk-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleToolCall(name, args || {});
  return { content: [{ type: 'text', text: result }] };
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
