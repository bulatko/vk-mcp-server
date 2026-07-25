/**
 * MCP protocol tests
 *
 * These spawn the real server as a child process and talk to it over stdio
 * using the official MCP client. Unlike unit tests that assert on local
 * literals, these fail if src/index.js is broken, missing, or drifts from
 * its declared contract.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let client;
let transport;
let tools;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    // Server refuses to boot without a token; never a real one in tests.
    env: { ...process.env, VK_ACCESS_TOKEN: 'test_token_not_real' },
  });
  client = new Client({ name: 'vk-mcp-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  tools = (await client.listTools()).tools;
}, 30000);

afterAll(async () => {
  await client?.close();
});

describe('MCP handshake', () => {
  it('reports a server name and version', () => {
    const info = client.getServerVersion();
    expect(info.name).toBe('vk-mcp-server');
    expect(info.version).toEqual(expect.any(String));
  });

  it('advertises the version from package.json', () => {
    // Guards the drift that shipped in 0.1.2: server announced 0.1.0.
    expect(client.getServerVersion().version).toBe(pkg.version);
  });

  it('declares the tools capability', () => {
    expect(client.getServerCapabilities()).toHaveProperty('tools');
  });
});

describe('tools/list', () => {
  it('returns a non-empty tool list', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it('exposes every documented tool', () => {
    const expected = [
      'vk_users_get',
      'vk_wall_get',
      'vk_wall_post',
      'vk_wall_create_comment',
      'vk_wall_get_by_id',
      'vk_wall_edit',
      'vk_wall_delete',
      'vk_photos_upload_wall',
      'vk_groups_get',
      'vk_groups_get_by_id',
      'vk_friends_get',
      'vk_newsfeed_get',
      'vk_stats_get',
      'vk_photos_get',
    ];
    const names = tools.map((t) => t.name);
    expected.forEach((name) => expect(names).toContain(name));
  });

  it('uses the vk_* naming convention', () => {
    tools.forEach((t) => expect(t.name).toMatch(/^vk_[a-z_]+$/));
  });

  it('gives every tool a description and an object schema', () => {
    tools.forEach((t) => {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe('object');
    });
  });

  it('declares required fields that actually exist in properties', () => {
    tools.forEach((t) => {
      (t.inputSchema.required || []).forEach((field) => {
        expect(Object.keys(t.inputSchema.properties || {})).toContain(field);
      });
    });
  });

  it('requires the fields the API cannot default', () => {
    const required = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required || []]));
    expect(required.vk_wall_post).toContain('message');
    expect(required.vk_wall_create_comment).toEqual(
      expect.arrayContaining(['owner_id', 'post_id', 'message'])
    );
    expect(required.vk_wall_edit).toContain('post_id');
    expect(required.vk_wall_delete).toContain('post_id');
    expect(required.vk_wall_get_by_id).toContain('posts');
    expect(required.vk_stats_get).toContain('group_id');
    expect(required.vk_photos_upload_wall).toContain('image');
  });

  it('has no duplicate tool names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('tools/call', () => {
  it('rejects an unknown tool without crashing the server', async () => {
    const res = await client.callTool({ name: 'vk_not_a_tool', arguments: {} });
    const text = res.content[0].text;
    expect(text).toMatch(/Unknown tool/i);

    // Server must still be alive and serving after a bad call.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });
});
