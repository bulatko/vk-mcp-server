/**
 * Two tokens at once
 *
 * A community token posts but VK refuses it a wall read (error 27); a service
 * key reads but cannot post. With both configured the server puts each read the
 * token is refused to the key. The fake VK below answers by token, the way the
 * real one did when this was checked live with a community token.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

const COMMUNITY = 'community_token_not_real';
const KEY = 'service_key_not_real';

const refuse = (code, msg) => ({ error: { error_code: code, error_msg: msg } });

/** What VK answers, by token and method. */
const answer = (token, method) => {
  if (token === COMMUNITY) {
    if (method === 'wall.post') return { response: { post_id: 5 } };
    if (method === 'users.get') return { response: [{ id: 1, first_name: 'Pavel' }] };
    return refuse(27, 'Group authorization failed: method is unavailable with group auth.');
  }
  if (token === KEY) {
    if (method === 'wall.get') return { response: { count: 1, items: [{ id: 9, text: 'public' }] } };
    if (method === 'users.get') return { response: [{ id: 1, first_name: 'Pavel' }] };
    return refuse(28, 'Application authorization failed: method is unavailable with service token.');
  }
  return refuse(5, 'User authorization failed: invalid access_token.');
};

let http;
/** Requests the server made: method and the token it used. */
let received = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.replace(/^\/+/, '');
      const token = new URLSearchParams(body).get('access_token');
      received.push({ method, token });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(token, method)));
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

/** Starts the server with the given tokens; the caller closes the client. */
const connect = async (tokens) => {
  const env = { ...process.env, VK_API_BASE: `http://127.0.0.1:${http.address().port}` };
  delete env.VK_ACCESS_TOKEN;
  delete env.VK_SERVICE_KEY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...env, ...tokens },
  });
  const client = new Client({ name: 'token-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
};

const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
};

describe('community token with a service key', () => {
  let client;
  beforeAll(async () => {
    client = await connect({ VK_ACCESS_TOKEN: COMMUNITY, VK_SERVICE_KEY: KEY });
  }, 30000);
  afterAll(async () => {
    await client?.close();
  });

  it('reads a wall with the key after the token is refused', async () => {
    const { isError, body } = await call(client, 'vk_wall_get', { owner_id: '-1' });
    expect(isError).toBe(false);
    expect(body.items).toEqual([{ id: 9, text: 'public' }]);
    expect(received).toEqual([
      { method: 'wall.get', token: COMMUNITY },
      { method: 'wall.get', token: KEY },
    ]);
  });

  it('goes straight to the key for a method the token was already refused', async () => {
    await call(client, 'vk_wall_get', { owner_id: '-1' });
    expect(received).toEqual([{ method: 'wall.get', token: KEY }]);
  });

  it('posts with the token, never the key', async () => {
    const { isError, body } = await call(client, 'vk_wall_post', { owner_id: '-1', message: 'hi' });
    expect(isError).toBe(false);
    expect(body.post_id).toBe(5);
    expect(received).toEqual([{ method: 'wall.post', token: COMMUNITY }]);
  });

  it('reports the token refusal, not the key one, when neither can do it', async () => {
    const { isError, body } = await call(client, 'vk_wall_edit', { owner_id: '-1', post_id: 5, message: 'x' });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/Error 27/);
    expect(body.error).toMatch(/community token cannot/i);
    // the key was tried: say so, instead of advising to set it
    expect(body.error).toMatch(/VK_SERVICE_KEY is set and was refused too \(error 28\)/);
    expect(body.error).not.toMatch(/VK API Error 28/);
  });

  it('does not retry an answer that is not about the kind of token', async () => {
    // users.get works with the community token: one request, no fallback
    await call(client, 'vk_users_get', { user_ids: '1' });
    expect(received).toEqual([{ method: 'users.get', token: COMMUNITY }]);
  });
});

describe('only a service key', () => {
  let client;
  beforeAll(async () => {
    client = await connect({ VK_SERVICE_KEY: KEY });
  }, 30000);
  afterAll(async () => {
    await client?.close();
  });

  it('reads with the key', async () => {
    const { isError } = await call(client, 'vk_wall_get', { owner_id: '-1' });
    expect(isError).toBe(false);
    expect(received).toEqual([{ method: 'wall.get', token: KEY }]);
  });

  it('lets a write fail with what VK said', async () => {
    const { isError, body } = await call(client, 'vk_wall_post', { owner_id: '-1', message: 'hi' });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/Error 28/);
  });
});

describe('only a community token', () => {
  let client;
  beforeAll(async () => {
    client = await connect({ VK_ACCESS_TOKEN: COMMUNITY });
  }, 30000);
  afterAll(async () => {
    await client?.close();
  });

  it('explains the refused read and points at the key', async () => {
    const { isError, body } = await call(client, 'vk_wall_get', { owner_id: '-1' });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/VK_SERVICE_KEY/);
    expect(received).toEqual([{ method: 'wall.get', token: COMMUNITY }]);
  });
});
