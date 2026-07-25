/**
 * Interactive token helper: `npx vk-mcp-server --login`.
 *
 * Getting a VK token is the step people get stuck on. The old implicit flow
 * (response_type=token) now answers "Security Error" for newly created apps —
 * VK moved to VK ID, which is OAuth 2.1 with PKCE. This walks that flow with a
 * throwaway local redirect, so nothing has to be pasted out of an address bar.
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
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
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

/** Waits for VK to redirect back, and answers the browser while it does. */
function waitForCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (url.pathname !== '/callback') {
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
    console.error('Usage: npx vk-mcp-server --login <APP_ID>   (or set VK_APP_ID)\n');
    console.error('Create a Standalone app at https://vk.com/editapp?act=create to get an App ID.');
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
  console.error('Opening VK in your browser. If nothing opens, visit:\n');
  console.error(`${authorizeUrl}\n`);
  openBrowser(authorizeUrl.toString());

  let code;
  let deviceId;
  try {
    ({ code, deviceId } = await waitForCallback(server, state));
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
  console.error('\nClaude Desktop users: paste it into the extension settings field instead.');
}
