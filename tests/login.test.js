/**
 * Token helper tests
 *
 * Drives `--login` end to end against a stand-in for VK ID (VK_ID_BASE), so the
 * PKCE handshake, the callback and the token exchange are all exercised without
 * a browser, a real app or a real account.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const LOGIN_PORT = 8791;

let idServer;
let idPort;
/** Token-exchange requests the helper made to the fake VK ID. */
let exchanges = [];
let tokenResponse = { access_token: 'vk1.a.fake_token', expires_in: 0 };

beforeAll(async () => {
  idServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      exchanges.push({ url: req.url, params: Object.fromEntries(new URLSearchParams(body)) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(tokenResponse));
    });
  });
  await new Promise((r) => idServer.listen(0, '127.0.0.1', r));
  idPort = idServer.address().port;
});

afterAll(async () => {
  await new Promise((r) => idServer.close(r));
});

beforeEach(() => {
  exchanges = [];
  tokenResponse = { access_token: 'vk1.a.fake_token', expires_in: 0 };
});

/**
 * Starts `--login`, waits for it to print the authorize URL, and returns the
 * parsed URL plus a handle on the process.
 */
function startLogin(port = LOGIN_PORT) {
  const child = spawn(process.execPath, [SERVER, '--login', '54470067'], {
    env: {
      ...process.env,
      VK_ID_BASE: `http://127.0.0.1:${idPort}`,
      VK_LOGIN_PORT: String(port),
    },
  });

  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));

  const authorizeUrl = new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      stderr += d;
      const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/);
      if (match) resolve(new URL(match[0]));
    });
    child.on('exit', () => reject(new Error(`helper exited early:\n${stderr}`)));
  });

  return {
    child,
    authorizeUrl,
    output: () => ({ stdout, stderr }),
    done: () => new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  };
}

describe('--login', () => {
  it('builds an OAuth 2.1 authorize request with a valid PKCE challenge', async () => {
    const session = startLogin(8792);
    const url = await session.authorizeUrl;
    const q = url.searchParams;

    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('54470067');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8792/callback');
    expect(q.get('scope')).toContain('wall');
    expect(q.get('state')).toBeTruthy();

    // The challenge has to be a base64url SHA-256 of the verifier the helper
    // keeps; we cannot see the verifier, but we can check the shape.
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    session.child.kill();
    await session.done();
  }, 20000);

  it('exchanges the code for a token and prints it', async () => {
    const session = startLogin(8793);
    const url = await session.authorizeUrl;
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');

    await fetch(`http://127.0.0.1:8793/callback?code=abc123&device_id=dev1&state=${state}`);
    const exitCode = await session.done();

    expect(exitCode).toBe(0);
    expect(exchanges).toHaveLength(1);

    const sent = exchanges[0].params;
    expect(sent.grant_type).toBe('authorization_code');
    expect(sent.code).toBe('abc123');
    expect(sent.device_id).toBe('dev1');
    expect(sent.client_id).toBe('54470067');
    expect(sent.redirect_uri).toBe('http://127.0.0.1:8793/callback');

    // The verifier must hash to the challenge sent at the start of the flow —
    // this is what makes the exchange safe without a client secret.
    const derived = createHash('sha256')
      .update(sent.code_verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(derived).toBe(challenge);

    // The token goes to stdout alone so it can be piped.
    expect(session.output().stdout.trim()).toBe('vk1.a.fake_token');
  }, 20000);

  it('refuses a callback whose state does not match', async () => {
    const session = startLogin(8794);
    await session.authorizeUrl;

    const res = await fetch('http://127.0.0.1:8794/callback?code=abc&device_id=d&state=forged');
    expect(res.status).toBe(400);

    const exitCode = await session.done();
    expect(exitCode).toBe(1);
    expect(session.output().stderr).toMatch(/state mismatch/i);
    // A forged callback must never reach the token endpoint.
    expect(exchanges).toHaveLength(0);
  }, 20000);

  it('reports what VK said when authorisation is refused', async () => {
    const session = startLogin(8795);
    await session.authorizeUrl;

    await fetch('http://127.0.0.1:8795/callback?error=access_denied&error_description=User%20denied');
    const exitCode = await session.done();

    expect(exitCode).toBe(1);
    expect(session.output().stderr).toMatch(/User denied/);
  }, 20000);
});
