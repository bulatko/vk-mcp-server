/**
 * What each kind of token is shown
 *
 * The server asks VK once which token it holds and lists only the tools that
 * token (with the service key, if set) reaches. The fake VK below answers the
 * way the real one did for each kind; the expected lists are the live
 * measurements the server's tables were built from. Anything uncertain — a
 * rejected token, a VK that is down — must leave every tool listed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'index.js');
const EVERY_TOOL = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
  .tools.map((t) => t.name)
  .sort();

const COMMUNITY = 'community_token_not_real';
const USER = 'user_token_not_real';
const VKID = 'vk2.a.vkid_token_not_real';
const KEY = 'service_key_not_real';
const INVALID = 'invalid_token_not_real';
const VK_DOWN = 'token_while_vk_is_down';

const refuse = (code, msg) => ({ error: { error_code: code, error_msg: msg } });
const groupAuth = refuse(27, 'Group authorization failed: method is unavailable with group auth.');

/** What VK answers, by token and method; null means an HTTP 500. */
const answer = (token, method) => {
  switch (token) {
    case COMMUNITY:
      if (method === 'groups.getTokenPermissions') {
        return { response: { mask: 12288, permissions: [{ name: 'wall', setting: 8192 }, { name: 'messages', setting: 4096 }] } };
      }
      if (method === 'groups.getById') return { response: { groups: [{ id: 42, name: 'Тест', screen_name: 'club42' }] } };
      if (method === 'messages.getConversations') return refuse(15, 'Access denied: community messages are disabled');
      return groupAuth;
    case USER:
      if (method === 'users.get') return { response: [{ id: 7, first_name: 'Ivan' }] };
      return refuse(15, 'Access denied: no access to call this method');
    case VKID:
      return refuse(1051, 'Method is not available for this profile type');
    case KEY:
      if (method === 'wall.get') return { response: { count: 0, items: [] } };
      return refuse(28, 'Application authorization failed: method is unavailable with service token.');
    case VK_DOWN:
      return null;
    default:
      return refuse(5, 'User authorization failed: invalid access_token (4).');
  }
};

let http;
let received = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.replace(/^\/+/, '');
      const token = new URLSearchParams(body).get('access_token');
      received.push({ method, token });
      const reply = answer(token, method);
      if (!reply) {
        res.statusCode = 500;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise((r) => http.close(r));
});

beforeEach(() => {
  received = [];
});

/** Starts the server with the given tokens, runs fn with a client, closes it. */
const withServer = async (tokens, fn) => {
  const env = { ...process.env, VK_API_BASE: `http://127.0.0.1:${http.address().port}` };
  delete env.VK_ACCESS_TOKEN;
  delete env.VK_SERVICE_KEY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...env, ...tokens } });
  const client = new Client({ name: 'token-reach-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
};

const listed = (tokens) => withServer(tokens, async (c) => (await c.listTools()).tools.map((t) => t.name).sort());

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text), structured: res.structuredContent };
};

const COMMUNITY_REACH = [
  'vk_events_get',
  'vk_events_listen',
  'vk_groups_get_by_id',
  'vk_groups_get_members',
  'vk_messages_get_conversations',
  'vk_messages_get_history',
  'vk_messages_mark_as_read',
  'vk_messages_send',
  'vk_stories_post_photo',
  'vk_stories_post_video',
  'vk_token_info',
  'vk_users_get',
  'vk_wall_create_comment',
  'vk_wall_post',
];
const KEY_REACH = ['vk_groups_get_by_id', 'vk_groups_get_members', 'vk_token_info', 'vk_users_get', 'vk_wall_get'];
const INBOX = ['vk_events_get', 'vk_events_listen', 'vk_messages_get_conversations', 'vk_messages_get_history', 'vk_messages_mark_as_read', 'vk_messages_send'];

describe('tools/list by token kind', () => {
  it('shows a community token what it posts, comments, publishes and answers with', async () => {
    expect(await listed({ VK_ACCESS_TOKEN: COMMUNITY })).toEqual(COMMUNITY_REACH);
  });

  it('adds the reads a service key makes when one is set beside it', async () => {
    const names = await listed({ VK_ACCESS_TOKEN: COMMUNITY, VK_SERVICE_KEY: KEY });
    expect(names).toEqual([...COMMUNITY_REACH, 'vk_wall_get'].sort());
    // neither token reads a post by id: the key is refused it too (1051, live 2026-10-10)
    expect(names).not.toContain('vk_wall_get_by_id');
  });

  it('shows a lone service key its public reads, without asking VK', async () => {
    expect(await listed({ VK_SERVICE_KEY: KEY })).toEqual(KEY_REACH);
    expect(received).toEqual([]);
  });

  it('recognises a service key put in VK_ACCESS_TOKEN', async () => {
    expect(await listed({ VK_ACCESS_TOKEN: KEY })).toEqual(KEY_REACH);
  });

  it('shows a VK ID token what a key reads', async () => {
    expect(await listed({ VK_ACCESS_TOKEN: VKID })).toEqual(KEY_REACH);
  });

  it('shows a user token everything but the community inbox', async () => {
    expect(await listed({ VK_ACCESS_TOKEN: USER })).toEqual(EVERY_TOOL.filter((n) => !INBOX.includes(n)));
  });

  it('lists every tool when VK rejects the token', async () => {
    expect(await listed({ VK_ACCESS_TOKEN: INVALID })).toEqual(EVERY_TOOL);
  });

  it('lists every tool when VK cannot be asked', async () => {
    expect(await listed({ VK_ACCESS_TOKEN: VK_DOWN })).toEqual(EVERY_TOOL);
  });

  it('lists every tool without a token, as registries introspect', async () => {
    expect(await listed({})).toEqual(EVERY_TOOL);
  });

  it('asks VK once, however often the list is read', async () => {
    await withServer({ VK_ACCESS_TOKEN: COMMUNITY }, async (c) => {
      await c.listTools();
      await c.listTools();
      await call(c, 'vk_token_info');
    });
    expect(received.map((r) => r.method)).toEqual(['groups.getTokenPermissions', 'groups.getById']);
  });
});

describe('vk_token_info', () => {
  it('names the community, its rights, and what would open each closed tool', async () => {
    const { isError, structured } = await withServer({ VK_ACCESS_TOKEN: COMMUNITY }, (c) => call(c, 'vk_token_info'));
    expect(isError).toBe(false);
    expect(structured).toMatchObject({
      kind: 'community',
      community: { id: 42, name: 'Тест', screen_name: 'club42' },
      scopes: ['wall', 'messages'],
      service_key: false,
    });
    expect(structured.tools.sort()).toEqual(COMMUNITY_REACH);
    const why = Object.fromEntries(structured.unavailable.map((u) => [u.tool, u.reason]));
    expect(why.vk_wall_get).toMatch(/VK_SERVICE_KEY/);
    expect(why.vk_wall_edit).toMatch(/user tokens/);
    expect(Object.keys(why).sort()).toEqual(EVERY_TOOL.filter((n) => !COMMUNITY_REACH.includes(n)));
  });

  it('points a service key at a community token for writing', async () => {
    const { structured } = await withServer({ VK_SERVICE_KEY: KEY }, (c) => call(c, 'vk_token_info'));
    expect(structured.kind).toBe('service');
    const why = Object.fromEntries(structured.unavailable.map((u) => [u.tool, u.reason]));
    expect(why.vk_wall_post).toMatch(/community token/);
  });

  it('says why it could not tell, and leaves every tool available', async () => {
    const { structured } = await withServer({ VK_ACCESS_TOKEN: INVALID }, (c) => call(c, 'vk_token_info'));
    expect(structured).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/error 5/) });
    expect(structured.unavailable).toEqual([]);
  });

  it('works with no token at all, and says none of the others will', async () => {
    const { isError, structured } = await withServer({}, (c) => call(c, 'vk_token_info'));
    expect(isError).toBe(false);
    expect(structured.kind).toBe('none');
    expect(structured.tools).toEqual(['vk_token_info']);
  });
});

describe('a tool left off the list', () => {
  it('still answers when called, with what VK said', async () => {
    const { isError, body } = await withServer({ VK_ACCESS_TOKEN: COMMUNITY }, (c) =>
      call(c, 'vk_wall_edit', { owner_id: '-42', post_id: 1, message: 'x' })
    );
    expect(isError).toBe(true);
    expect(body.error).toMatch(/Error 27/);
  });
});

describe('community messages switched off', () => {
  it('says how to turn them on instead of blaming privacy', async () => {
    const { isError, body } = await withServer({ VK_ACCESS_TOKEN: COMMUNITY }, (c) =>
      call(c, 'vk_messages_get_conversations')
    );
    expect(isError).toBe(true);
    expect(body.error).toMatch(/Manage → Messages/);
    expect(body.error).not.toMatch(/private profile/);
  });
});
