/**
 * `--check` tests
 *
 * Runs the diagnostic against a stand-in VK so each token type can be simulated
 * without real credentials.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let vk;
let port;
/** method → response, set per test. */
let responses = {};

beforeAll(async () => {
  vk = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.replace(/^\/+/, '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(responses[method] ?? { response: { count: 0, items: [] } }));
    });
  });
  await new Promise((r) => vk.listen(0, '127.0.0.1', r));
  port = vk.address().port;
});

afterAll(async () => {
  await new Promise((r) => vk.close(r));
});

beforeEach(() => {
  responses = {};
});

function runCheck(token = 'some_token') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, '--check'], {
      env: { ...process.env, VK_ACCESS_TOKEN: token, VK_API_BASE: `http://127.0.0.1:${port}` },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

describe('--check', () => {
  it('names the account behind a user token', async () => {
    responses['users.get'] = { response: [{ id: 42, first_name: 'Test', last_name: 'User' }] };
    const { code, stderr } = await runCheck();

    expect(code).toBe(0);
    expect(stderr).toMatch(/User token/);
    expect(stderr).toMatch(/Test User \(id 42\)/);
  }, 20000);

  it('recognises a community token by who it acts as', async () => {
    // A community token answers users.get with an empty array.
    responses['users.get'] = { response: [] };
    responses['groups.getById'] = { response: { groups: [{ id: 7, name: 'Test Community' }] } };
    const { stderr } = await runCheck();

    expect(stderr).toMatch(/Community token/);
    expect(stderr).toMatch(/Test Community/);
  }, 20000);

  it('recognises a service token and says what it cannot reach', async () => {
    responses['users.get'] = { response: [] };
    responses['groups.getById'] = { response: { groups: [] } };
    responses['friends.get'] = { error: { error_code: 28, error_msg: 'unavailable with service token' } };
    responses['newsfeed.get'] = { error: { error_code: 28, error_msg: 'unavailable with service token' } };
    const { stderr } = await runCheck();

    expect(stderr).toMatch(/Service token/);
    expect(stderr).toMatch(/read your friends/);
    expect(stderr).toMatch(/--login/);
  }, 20000);

  it('probes the reads that a weak token silently loses', async () => {
    // A service token passes users.get and fails these; reporting only the
    // first led people to believe reading worked until they hit one of them.
    const refused = { error: { error_code: 1051, error_msg: 'unavailable with current profile type' } };
    responses['users.get'] = { response: [] };
    responses['groups.getById'] = { response: { groups: [] } };
    responses['wall.getById'] = refused;
    responses['photos.get'] = refused;
    responses['likes.getList'] = refused;
    const { stderr } = await runCheck();

    expect(stderr).toMatch(/vk_wall_get_by_id/);
    expect(stderr).toMatch(/vk_photos_get/);
    expect(stderr).toMatch(/vk_likes_get/);
  }, 20000);

  it('does not claim to know why a community hid its members', async () => {
    // VK answers 15 both when the community hides members and when the token
    // kind may never see them; the output must not pick one.
    responses['users.get'] = { response: [{ id: 1, first_name: 'A', last_name: 'B' }] };
    responses['groups.getMembers'] = { error: { error_code: 15, error_msg: 'Access denied: group hide members' } };
    const { stderr } = await runCheck();

    expect(stderr).toMatch(/hidden by the community, or by this token kind/);
  }, 20000);

  it('says statistics were not probed rather than guessing', async () => {
    // stats.get needs admin rights on one particular community, so probing a
    // public one would report a failure that says nothing about the token.
    responses['users.get'] = { response: [{ id: 1, first_name: 'A', last_name: 'B' }] };
    const { stderr } = await runCheck();

    expect(stderr).toMatch(/vk_stats_get.*not probed|not probed.*admin rights/s);
  }, 20000);

  it('explains an expired token instead of printing a bare code', async () => {
    responses['users.get'] = { error: { error_code: 5, error_msg: 'User authorization failed' } };
    const { code, stderr } = await runCheck();

    expect(code).toBe(1);
    expect(stderr).toMatch(/expired or was revoked/i);
    expect(stderr).toMatch(/--login/);
  }, 20000);

  it('explains a blocked app, which is otherwise indistinguishable from a bad token', async () => {
    responses['users.get'] = { error: { error_code: 8, error_msg: 'Application is blocked' } };
    const { stderr } = await runCheck();

    expect(stderr).toMatch(/blocked/i);
    expect(stderr).toMatch(/editapp/);
  }, 20000);

  it('refuses to run without a token', async () => {
    const child = spawn(process.execPath, [SERVER, '--check'], {
      env: { ...process.env, VK_ACCESS_TOKEN: '', VK_API_BASE: `http://127.0.0.1:${port}` },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((r) => child.on('exit', r));

    expect(code).toBe(1);
    expect(stderr).toMatch(/not set/i);
  }, 20000);

  it('never calls a write method', async () => {
    const called = [];
    const spy = createServer((req, res) => {
      called.push(req.url.replace(/^\/+/, ''));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: [{ id: 1, first_name: 'A', last_name: 'B' }] }));
    });
    await new Promise((r) => spy.listen(0, '127.0.0.1', r));

    await new Promise((resolve) => {
      const child = spawn(process.execPath, [SERVER, '--check'], {
        env: {
          ...process.env,
          VK_ACCESS_TOKEN: 'x',
          VK_API_BASE: `http://127.0.0.1:${spy.address().port}`,
        },
      });
      child.on('exit', resolve);
    });
    await new Promise((r) => spy.close(r));

    expect(called.length).toBeGreaterThan(0);
    called.forEach((method) => {
      expect(method).not.toMatch(/post|edit|delete|createComment|join|save/i);
    });
  }, 20000);
});
