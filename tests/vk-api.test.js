/**
 * VK API request tests
 *
 * A local HTTP server stands in for api.vk.com (via the VK_API_BASE override),
 * so these assert on the bytes the server actually sends and on how it handles
 * what VK sends back — no real network, no real token.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let http;
let client;
let transport;
/** Requests the server made to the fake VK API. */
let received = [];
/** Response the fake VK API returns next. */
let nextResponse = { response: { ok: true } };

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

/** Params of the last request, as VK would parse them. */
const lastParams = () => Object.fromEntries(new URLSearchParams(received.at(-1).body));

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.url.replace(/^\/+/, ''), body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(nextResponse));
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      VK_ACCESS_TOKEN: 'test_token_not_real',
      VK_API_BASE: `http://127.0.0.1:${http.address().port}`,
    },
  });
  client = new Client({ name: 'vk-api-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  await client?.close();
  await new Promise((r) => http.close(r));
});

beforeEach(() => {
  received = [];
  nextResponse = { response: { ok: true } };
});

describe('request shape', () => {
  it('calls the VK method matching the tool', async () => {
    await call('vk_users_get', { user_ids: '1' });
    expect(received.at(-1).method).toBe('users.get');
  });

  it('sends the access token and API version on every call', async () => {
    await call('vk_users_get', { user_ids: '1' });
    const params = lastParams();
    expect(params.access_token).toBe('test_token_not_real');
    expect(params.v).toBe('5.199');
  });

  it('forwards caller arguments', async () => {
    await call('vk_wall_get', { domain: 'durov', count: 5 });
    const params = lastParams();
    expect(params.domain).toBe('durov');
    expect(params.count).toBe('5');
  });

  it('applies documented defaults when the caller omits them', async () => {
    await call('vk_wall_get', { domain: 'durov' });
    expect(lastParams().count).toBe('20');
  });

  it('maps each read tool to its VK method', async () => {
    const cases = [
      ['vk_groups_get_by_id', { group_ids: '1' }, 'groups.getById'],
      ['vk_friends_get', { user_id: 1 }, 'friends.get'],
      ['vk_newsfeed_get', {}, 'newsfeed.get'],
      ['vk_stats_get', { group_id: 1 }, 'stats.get'],
      ['vk_photos_get', { owner_id: 1 }, 'photos.get'],
      ['vk_wall_get_by_id', { posts: '-1_2' }, 'wall.getById'],
    ];
    for (const [tool, args, method] of cases) {
      received = [];
      await call(tool, args);
      expect(received.at(-1).method).toBe(method);
    }
  });

  it('maps each write tool to its VK method', async () => {
    const cases = [
      ['vk_wall_post', { message: 'hi' }, 'wall.post'],
      ['vk_wall_edit', { post_id: 1, message: 'edited' }, 'wall.edit'],
      ['vk_wall_delete', { post_id: 1 }, 'wall.delete'],
      ['vk_wall_create_comment', { owner_id: 1, post_id: 2, message: 'yo' }, 'wall.createComment'],
    ];
    for (const [tool, args, method] of cases) {
      received = [];
      await call(tool, args);
      expect(received.at(-1).method).toBe(method);
    }
  });
});

describe('optional parameters', () => {
  // KNOWN BUG — unskip when PR #4 lands.
  // URLSearchParams stringifies undefined/null, so omitted arguments reach VK
  // as the literal text "undefined" (e.g. owner_id=undefined). Verified live:
  //   owner_id=undefined&domain=durov&count=20&offset=undefined&filter=undefined
  // The fix belongs in VKClient.call(), which is exactly what PR #4 does; we
  // keep it skipped rather than patch it here so that PR merges without conflict.
  it.skip('omits arguments the caller did not provide', async () => {
    await call('vk_wall_get', { domain: 'durov' });
    const body = received.at(-1).body;
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
    expect(lastParams()).not.toHaveProperty('owner_id');
  });

  // KNOWN BUG — unskip once the handler defaults move from `||` to `??`.
  // Handlers use `args.count || 20`, so an explicit 0 is silently replaced by
  // the default. Same pattern in intervals_count, offset and friends. Deferred
  // because the fix edits the same handler lines that PRs #5–#9 extend.
  it.skip('keeps falsy-but-meaningful values', async () => {
    await call('vk_wall_get', { owner_id: 0, count: 0 });
    const params = lastParams();
    expect(params.owner_id).toBe('0');
    expect(params.count).toBe('0');
  });
});

describe('VK error handling', () => {
  it('surfaces the VK error code and message', async () => {
    nextResponse = { error: { error_code: 5, error_msg: 'User authorization failed.' } };
    const result = await call('vk_users_get', { user_ids: '1' });
    expect(result.error).toMatch(/5/);
    expect(result.error).toMatch(/authorization failed/i);
  });

  it('never leaks the access token in error text', async () => {
    nextResponse = { error: { error_code: 5, error_msg: 'User authorization failed.' } };
    const result = await call('vk_users_get', { user_ids: '1' });
    expect(JSON.stringify(result)).not.toContain('test_token_not_real');
  });

  it('keeps serving after an error', async () => {
    nextResponse = { error: { error_code: 6, error_msg: 'Too many requests per second.' } };
    await call('vk_users_get', { user_ids: '1' });

    nextResponse = { response: [{ id: 1, first_name: 'Test' }] };
    const result = await call('vk_users_get', { user_ids: '1' });
    expect(result[0].first_name).toBe('Test');
  });
});

describe('responses', () => {
  it('returns the VK payload unwrapped from its envelope', async () => {
    nextResponse = { response: { count: 2, items: [{ id: 1 }, { id: 2 }] } };
    const result = await call('vk_wall_get', { domain: 'durov' });
    expect(result.count).toBe(2);
    expect(result.items).toHaveLength(2);
  });
});
