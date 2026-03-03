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
    const body = new URLSearchParams({
      ...params,
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
  wallPost(params) { return this.call('wall.post', params); }
  wallCreateComment(params) { return this.call('wall.createComment', params); }

  // Groups
  groupsGet(params) { return this.call('groups.get', { ...params, extended: 1 }); }
  groupsGetById(params) { return this.call('groups.getById', params); }

  // Friends
  friendsGet(params) { return this.call('friends.get', params); }

  // Newsfeed
  newsfeedGet(params) { return this.call('newsfeed.get', params); }

  // Stats
  statsGet(params) { return this.call('stats.get', params); }

  // Photos
  photosGet(params) { return this.call('photos.get', params); }
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
        });
        break;

      case 'vk_wall_post':
        result = await vk.wallPost({
          owner_id: args.owner_id,
          message: args.message,
          from_group: args.from_group ? 1 : 0,
        });
        break;

      case 'vk_wall_create_comment':
        result = await vk.wallCreateComment({
          owner_id: args.owner_id,
          post_id: args.post_id,
          message: args.message,
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
