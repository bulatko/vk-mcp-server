/**
 * Community events
 *
 * vk_events_listen turns on the community's Long Poll and starts polling it;
 * vk_events_get reads what arrived. The fake VK below has its own event server,
 * answering the way the real one did when this was checked live on 2026-10-10.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CommunityEvents, MAX_BUFFERED } from '../src/events.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const COMMUNITY = 'community_token_not_real';

let http;
let vk;

/** Fresh state of the fake VK: Long Poll off, nothing queued. */
const freshVk = () => ({
  settings: {
    is_enabled: false,
    api_version: '5.131',
    events: { wall_reply_new: 0, like_add: 0, group_join: 0, message_typing_state: 0, vkpay_transaction: 0 },
  },
  setCalls: [],
  serversIssued: 0,
  queue: [],
  failNext: null,
  ts: 1,
});

const api = (method, params) => {
  switch (method) {
    case 'groups.getTokenPermissions':
      return { mask: 262144, permissions: [{ name: 'manage', setting: 262144 }] };
    case 'groups.getById':
      return { groups: [{ id: 42, name: 'Тест', screen_name: 'club42' }] };
    case 'groups.getLongPollSettings':
      return structuredClone(vk.settings);
    case 'groups.setLongPollSettings': {
      vk.setCalls.push(params);
      if (params.enabled) vk.settings.is_enabled = params.enabled === '1';
      if (params.api_version) vk.settings.api_version = params.api_version;
      for (const type of Object.keys(params)) {
        // VK accepts the flag and leaves it off when the community lacks the feature
        if (type in vk.settings.events && type !== 'vkpay_transaction') vk.settings.events[type] = Number(params[type]);
      }
      return 1;
    }
    case 'groups.getLongPollServer':
      vk.serversIssued += 1;
      return { server: `http://127.0.0.1:${http.address().port}/lp`, key: `key${vk.serversIssued}`, ts: String(vk.ts) };
    default:
      return null;
  }
};

/** The event server: answers at once when something is queued, else after a short hold. */
const poll = async (res) => {
  for (let held = 0; !vk.queue.length && !vk.failNext && held < 200; held += 20) {
    await new Promise((r) => setTimeout(r, 20));
  }
  res.setHeader('content-type', 'application/json');
  if (vk.failNext) {
    const failed = vk.failNext;
    vk.failNext = null;
    res.end(JSON.stringify({ failed, ts: String(vk.ts) }));
    return;
  }
  vk.ts += 1;
  res.end(JSON.stringify({ ts: String(vk.ts), updates: vk.queue.splice(0) }));
};

beforeAll(async () => {
  http = createServer((req, res) => {
    if (req.url.startsWith('/lp')) {
      poll(res);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.replace(/^\/+/, '');
      const params = Object.fromEntries(new URLSearchParams(body));
      const response = params.access_token === COMMUNITY ? api(method, params) : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response === null
        ? { error: { error_code: 27, error_msg: 'Group authorization failed: method is unavailable with group auth.' } }
        : { response }));
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise((r) => http.close(r));
});

beforeEach(() => {
  vk = freshVk();
});

const connect = async () => {
  const env = { ...process.env, VK_API_BASE: `http://127.0.0.1:${http.address().port}`, VK_ACCESS_TOKEN: COMMUNITY };
  delete env.VK_SERVICE_KEY;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env });
  const client = new Client({ name: 'events-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
};

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text), structured: res.structuredContent };
};

const update = (type, object = {}) => ({ type, object, group_id: 42, event_id: `e${Math.random()}` });

describe('vk_events_listen', () => {
  let client;
  afterAll(async () => {
    await client?.close();
  });

  it('turns Long Poll on with its own API version when it is off, and starts listening', async () => {
    client = await connect();
    const { isError, structured } = await call(client, 'vk_events_listen', { types: ['wall_reply_new', 'like_add', 'vkpay_transaction'] });
    expect(isError).toBe(false);
    expect(structured).toMatchObject({ listening: true, community_id: 42, long_poll_turned_on: true });
    expect(structured.events_on.sort()).toEqual(['like_add', 'wall_reply_new']);
    // a type VK leaves off is reported, not claimed
    expect(structured.not_available).toEqual(['vkpay_transaction']);
    expect(vk.setCalls).toEqual([
      { group_id: '42', wall_reply_new: '1', like_add: '1', vkpay_transaction: '1', enabled: '1', api_version: '5.199', access_token: COMMUNITY, v: '5.199' },
    ]);
    expect(vk.serversIssued).toBe(1);
  });

  it('does not start a second listener when called again', async () => {
    const { structured } = await call(client, 'vk_events_listen');
    expect(structured).toMatchObject({ listening: true, community_id: 42 });
    expect(vk.serversIssued).toBe(0);
    expect(vk.setCalls).toEqual([]);
  });
});

describe('a community whose Long Poll another bot already reads', () => {
  it('turns on the missing event types and leaves its API version alone', async () => {
    vk.settings.is_enabled = true;
    vk.settings.events.group_join = 1;
    const client = await connect();
    try {
      const { structured } = await call(client, 'vk_events_listen', { types: ['group_join', 'wall_reply_new'] });
      expect(structured.long_poll_turned_on).toBe(false);
      expect(vk.setCalls).toHaveLength(1);
      expect(vk.setCalls[0]).toMatchObject({ wall_reply_new: '1' });
      expect(vk.setCalls[0]).not.toHaveProperty('api_version');
      expect(vk.setCalls[0]).not.toHaveProperty('enabled');
      expect(vk.setCalls[0]).not.toHaveProperty('group_join');
      expect(vk.settings.api_version).toBe('5.131');
    } finally {
      await client.close();
    }
  });
});

describe('vk_events_get', () => {
  let client;
  beforeAll(async () => {
    vk = freshVk();
    client = await connect();
    await call(client, 'vk_events_listen');
  }, 30000);
  afterAll(async () => {
    await client?.close();
  });

  it('returns what arrived, oldest first, without typing noise, and a cursor past it', async () => {
    vk.queue.push(
      update('like_add', { liker_id: 7, object_type: 'post', object_id: 5 }),
      update('message_typing_state', { from_id: 7 }),
      update('wall_reply_new', { id: 6, text: 'Проверка', post_id: 5, from_id: 7 })
    );
    const { isError, structured } = await call(client, 'vk_events_get', { wait: 5 });
    expect(isError).toBe(false);
    expect(structured.events.map((e) => e.type)).toEqual(['like_add', 'wall_reply_new']);
    expect(structured.events[1].object).toMatchObject({ id: 6, text: 'Проверка', post_id: 5 });
    expect(structured).toMatchObject({ listening: true, more: false });

    const again = await call(client, 'vk_events_get', { after: structured.cursor });
    expect(again.structured.events).toEqual([]);
    expect(again.structured.cursor).toBe(structured.cursor);
  });

  it('holds until the next event instead of answering empty', async () => {
    const { structured: first } = await call(client, 'vk_events_get');
    const started = Date.now();
    setTimeout(() => vk.queue.push(update('group_join', { user_id: 9 })), 300);
    const { structured } = await call(client, 'vk_events_get', { after: first.cursor, wait: 10 });
    expect(structured.events.map((e) => e.type)).toEqual(['group_join']);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('filters by type', async () => {
    vk.queue.push(update('like_add'), update('wall_reply_new', { id: 8 }));
    await call(client, 'vk_events_get', { wait: 5, types: ['wall_reply_new'] });
    const { structured } = await call(client, 'vk_events_get', { types: ['wall_reply_new'] });
    expect(structured.events.every((e) => e.type === 'wall_reply_new')).toBe(true);
  });

  it('asks VK for a new key when the old one expires, and keeps receiving', async () => {
    const { structured: first } = await call(client, 'vk_events_get');
    const issued = vk.serversIssued;
    vk.failNext = 2;
    await new Promise((r) => setTimeout(r, 400));
    expect(vk.serversIssued).toBe(issued + 1);
    vk.queue.push(update('like_remove'));
    const { structured } = await call(client, 'vk_events_get', { after: first.cursor, wait: 5 });
    expect(structured.events.map((e) => e.type)).toEqual(['like_remove']);
    expect(structured.listening).toBe(true);
  });
});

describe('before listening', () => {
  it('says to call vk_events_listen first', async () => {
    const client = await connect();
    try {
      const { isError, body } = await call(client, 'vk_events_get');
      expect(isError).toBe(true);
      expect(body.error).toMatch(/vk_events_listen/);
    } finally {
      await client.close();
    }
  });
});

describe('when the client hangs up', () => {
  it('stops polling, so the process exits instead of waiting to be killed', async () => {
    const client = await connect();
    await call(client, 'vk_events_listen');
    const started = Date.now();
    await client.close();
    // the transport kills a server that has not exited after ~2 s
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('the event buffer', () => {
  const events = () => new CommunityEvents(async () => ({}), 42);

  it(`keeps the last ${MAX_BUFFERED} and says how many a reader missed`, async () => {
    const stream = events();
    for (let i = 0; i < MAX_BUFFERED + 10; i++) stream.push(update('like_add'));
    const page = await stream.read({ limit: 50 });
    expect(page.missed).toBe(10);
    expect(page.events[0].seq).toBe(11);
    expect(page.events).toHaveLength(50);
    expect(page).toMatchObject({ more: true, cursor: 60 });
  });

  it('gives up waiting when the wait runs out', async () => {
    const started = Date.now();
    const page = await events().read({ wait: 0.3 });
    expect(page.events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('wakes a waiting reader when listening stops, and says why', async () => {
    const stream = events();
    const reading = stream.read({ wait: 20 });
    stream.stop('the client disconnected');
    const page = await reading;
    expect(page).toMatchObject({ listening: false, stopped_because: 'the client disconnected' });
  });
});
