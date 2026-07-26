/**
 * Interactive token helper: `npx vk-mcp-server --login`.
 *
 * Getting a VK token is the step people get stuck on. The old implicit flow
 * (response_type=token) now answers "Security Error" for newly created apps —
 * VK moved to VK ID, which is OAuth 2.1 with PKCE. This walks that flow with a
 * throwaway local redirect, so nothing has to be pasted out of an address bar.
 *
 * What it yields is a VK ID token (vk2.a…), and that is worth saying plainly:
 * VK issues those to sign a person in, not to drive the API. It reads public
 * profiles, walls and community info, and answers 1051 to the rest — posting,
 * photos, friends, statistics — no matter which scopes were requested. The
 * flow that granted full user tokens is gone, so for anything beyond reading
 * the answer is a community token, created in the community's own settings.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Overridable so the flow can be exercised against a stand-in in tests, and so
// users behind a mirror can point it elsewhere.
const ID_BASE = process.env.VK_ID_BASE || 'https://id.vk.ru';
const AUTHORIZE_URL = `${ID_BASE}/authorize`;
const TOKEN_URL = `${ID_BASE}/oauth2/auth`;
const PORT = Number(process.env.VK_LOGIN_PORT) || 8790;
// On a remote box the browser that authorises is not on the same machine as
// this helper, so a loopback redirect never comes back. VK_LOGIN_REDIRECT lets
// you point VK at a public URL that reaches this listener (e.g. through nginx).
const REDIRECT_URI = process.env.VK_LOGIN_REDIRECT || `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'wall,friends,groups,photos,stats,offline';

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;line-height:1.6">' +
  `<h2>${title}</h2>${body}</body>`;

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Headless box or no opener — the URL is printed either way.
  }
}

/**
 * Reads the redirect back from stdin, for when the browser is on another
 * machine entirely: VK sends it to a loopback address that belongs to the
 * laptop, the page fails to load, and the whole answer is sitting in the
 * address bar. Pasting it here beats standing up a public redirect.
 */
function waitForPaste(expectedState) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => l.includes('code='));
      if (!line) return;

      process.stdin.off('data', onData);
      process.stdin.pause();

      // Accept the whole redirect URL or just its query string: everything
      // from the first '?' is the query, and a bare query has no '?' to cut.
      const cut = line.indexOf('?');
      const params = new URLSearchParams(cut === -1 ? line.trim() : line.slice(cut + 1).trim());
      if (!params.has('code')) {
        reject(new Error('could not find code= in what was pasted'));
        return;
      }
      if (params.get('state') !== expectedState) {
        reject(new Error('state mismatch: that redirect belongs to a different login attempt'));
        return;
      }
      resolve({ code: params.get('code'), deviceId: params.get('device_id') });
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/** Waits for VK to redirect back, and answers the browser while it does. */
function waitForCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      // Match on the payload rather than the path: behind a reverse proxy the
      // public path (/vk-oauth-callback) rarely equals the local one.
      const isCallback = url.searchParams.has('code') || url.searchParams.has('error');
      if (!isCallback) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const deviceId = url.searchParams.get('device_id');

      if (error) {
        const description = url.searchParams.get('error_description') || error;
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Authorisation failed', `<p>${description}</p><p>You can close this tab.</p>`));
        reject(new Error(`VK returned ${error}: ${description}`));
        return;
      }

      // A mismatched state means the response did not come from the request we
      // started — refuse it rather than exchanging an attacker-supplied code.
      if (state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Authorisation failed', '<p>State mismatch — start over.</p>'));
        reject(new Error('state mismatch: the callback did not match this login attempt'));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Done', '<p>Token received. You can close this tab and go back to the terminal.</p>'));
      resolve({ code, deviceId });
    });
  });
}

export async function runLogin() {
  const appId = process.env.VK_APP_ID || process.argv[process.argv.indexOf('--login') + 1];

  if (!appId || appId.startsWith('--')) {
    console.error(`Usage: npx vk-mcp-server --login <APP_ID>   (or set VK_APP_ID)

You need your own VK app — two minutes, three steps:

  1. Open https://vk.com/editapp?act=create
     Give it any title, choose platform "Standalone", create it.

  2. Copy the App ID from the settings page (a number, not a secret).

  3. In the same settings, add this to the trusted redirect URIs:
        ${REDIRECT_URI}

Then run this command again with the App ID.

Only want to read and post in a community you manage? You do not need an app at
all — open the community, then Manage → API usage → Access tokens → Create
token, tick "wall" and "photos", and use that instead. It never expires.

Full guide: https://github.com/bulatko/vk-mcp-server/blob/master/docs/SETUP.md`);
    process.exit(1);
  }

  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`port ${PORT} is busy — set VK_LOGIN_PORT to a free one (and register it as a redirect)`)
          : err
      );
    });
    server.listen(PORT, '127.0.0.1', resolve);
  });

  console.error(`This app must allow ${REDIRECT_URI} as a redirect URI.`);
  console.error('Add it under Manage app → Settings → Trusted redirect URI if VK refuses.\n');

  if (process.env.VK_LOGIN_REDIRECT) {
    // A public redirect means the browser is probably not on this machine, and
    // VK binds the token to the IP that authorises. It will work for a minute
    // and then fail with error 5 subcode 1130, which looks like nothing.
    console.error('Warning: you are authorising through a public redirect, so the browser may');
    console.error('be on a different machine than this server. VK ties the token to the IP that');
    console.error('signs in, so such a token will start failing with error 5 (subcode 1130).');
    console.error('Run this on the machine that will host the server, or use a community token.\n');
  }
  console.error('Opening VK in your browser. If nothing opens, visit:\n');
  console.error(`${authorizeUrl}\n`);
  console.error('If the browser is on another machine, the page it lands on will fail to');
  console.error('load — that is expected. Copy the whole address it tried to open and paste');
  console.error('it here, then press Enter.\n');
  openBrowser(authorizeUrl.toString());

  let code;
  let deviceId;
  try {
    // Whichever arrives first: the redirect itself, or it pasted by hand.
    ({ code, deviceId } = await Promise.race([
      waitForCallback(server, state),
      waitForPaste(state),
    ]));
  } finally {
    server.close();
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: appId,
      device_id: deviceId,
      redirect_uri: REDIRECT_URI,
      state,
    }).toString(),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`token exchange failed: ${data.error_description || data.error || response.status}`);
  }

  // stdout carries the token alone, so it can be piped or captured; everything
  // else goes to stderr.
  console.error('Access token (store it as VK_ACCESS_TOKEN):\n');
  console.log(data.access_token);
  if (data.expires_in) {
    console.error(
      `\nExpires in ${data.expires_in}s. Request the offline scope for a token that does not expire.`
    );
  }

  // Said after the token rather than before, so it is read by someone about to
  // use it: this is what VK hands out now, and it does less than people expect.
  if (String(data.access_token).startsWith('vk2.')) {
    console.error('\nWhat this token can do: read public profiles, walls and community info.');
    console.error('What it cannot: post, edit, upload photos, or read friends, feeds and');
    console.error('statistics — VK ID issues this token to sign you in and keeps those');
    console.error('methods closed to it (error 1051). No scope changes that; the flow that');
    console.error('granted full user tokens is retired.');
    console.error('\nTo write, use a community token instead: open a community you manage →');
    console.error('Manage → API usage → Access tokens → Create token, ticking wall and photos.');
    console.error('It acts as the community, never expires, and is tied to no browser or IP.');
  }

  console.error('\nClaude Desktop users: paste it into the extension settings field instead.');
}
