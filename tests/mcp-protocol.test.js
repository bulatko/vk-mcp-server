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
      'vk_users_search',
      'vk_groups_search',
      'vk_groups_get_members',
      'vk_groups_join',
      'vk_likes_get',
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
      // A one-liner tells the model what the tool is called, not when to reach
      // for it or what it will get back.
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.inputSchema.type).toBe('object');
    });
  });

  it('gives every tool a readable title', () => {
    // Without one, clients show the raw name — "vk_wall_get_by_id".
    tools.forEach((t) => {
      expect(t.title || t.annotations?.title).toBeTruthy();
    });
  });

  it('explains the sign convention wherever an owner id is accepted', () => {
    // Community IDs are negative in wall context and positive in group context.
    // Getting it wrong is the most common VK mistake, and it fails confusingly.
    tools.forEach((t) => {
      const owner = t.inputSchema.properties?.owner_id;
      if (owner) expect(owner.description).toMatch(/negative|positive/i);

      const group = t.inputSchema.properties?.group_id;
      if (group) expect(group.description).toMatch(/positive|without the minus/i);
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
    expect(required.vk_users_search).toContain('q');
    expect(required.vk_groups_search).toContain('q');
    expect(required.vk_groups_get_members).toContain('group_id');
    expect(required.vk_groups_join).toContain('group_id');
    expect(required.vk_likes_get).toEqual(expect.arrayContaining(['type', 'item_id']));
  });

  it('annotates every tool so clients can tell reads from writes', () => {
    tools.forEach((t) => {
      expect(t.annotations).toBeDefined();
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(t.annotations.openWorldHint).toBe(true);
    });
  });

  it('marks the tools that write to VK', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    ['vk_wall_post', 'vk_wall_edit', 'vk_wall_delete', 'vk_wall_create_comment',
      'vk_photos_upload_wall', 'vk_groups_join'].forEach((name) => {
      expect(byName[name].readOnlyHint).toBe(false);
    });

    // Editing and deleting overwrite what is already there.
    expect(byName.vk_wall_edit.destructiveHint).toBe(true);
    expect(byName.vk_wall_delete.destructiveHint).toBe(true);
    // Publishing adds something new rather than replacing it.
    expect(byName.vk_wall_post.destructiveHint).toBe(false);
  });

  it('treats lookups as read-only', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    ['vk_users_get', 'vk_wall_get', 'vk_groups_get_members', 'vk_likes_get',
      'vk_stats_get', 'vk_newsfeed_get'].forEach((name) => {
      expect(byName[name].readOnlyHint).toBe(true);
      expect(byName[name].destructiveHint).toBe(false);
    });
  });

  it('declares an output schema for every tool', () => {
    // Without one the model receives a JSON blob as text and has to guess the shape.
    tools.forEach((t) => {
      expect(t.outputSchema).toBeDefined();
      expect(t.outputSchema.type).toBe('object');
    });
  });

  it('gives every tool an icon', () => {
    tools.forEach((t) => {
      expect(t.icons?.[0]?.src).toMatch(/^data:image\/svg\+xml/);
      expect(t.icons[0].mimeType).toBe('image/svg+xml');
    });
  });

  it('has no duplicate tool names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('prompts', () => {
  it('advertises the prompts capability', () => {
    expect(client.getServerCapabilities()).toHaveProperty('prompts');
  });

  it('lists prompts with arguments', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    prompts.forEach((p) => {
      expect(p.name).toMatch(/^[a-z_]+$/);
      expect(typeof p.description).toBe('string');
    });
    expect(prompts.map((p) => p.name)).toContain('community_digest');
  });

  it('builds a prompt from its arguments', async () => {
    const res = await client.getPrompt({
      name: 'community_digest',
      arguments: { community: 'apiclub', count: '5' },
    });
    const text = res.messages[0].content.text;
    expect(text).toContain('apiclub');
    expect(text).toContain('5');
    // A prompt is only useful if it points at the tools that answer it.
    expect(text).toMatch(/vk_wall_get/);
  });

  it('rejects a prompt that is missing a required argument', async () => {
    await expect(client.getPrompt({ name: 'community_digest', arguments: {} })).rejects.toThrow(
      /community/i
    );
  });

  it('rejects an unknown prompt', async () => {
    await expect(client.getPrompt({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown prompt/i);
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
