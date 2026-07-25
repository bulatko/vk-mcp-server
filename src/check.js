/**
 * `npx vk-mcp-server --check` — tells the user what their token actually is and
 * what it can do, before they wonder why half the tools answer with errors.
 *
 * VK has three kinds of token that look identical in a config file but differ
 * enormously in reach: a user token, a community token and a service token. The
 * failure mode is confusing — the server starts fine, some tools work, others
 * return codes like 1051 or 28 — so this probes a few cheap methods and reports
 * the shape of what you have.
 */

const VK_API_VERSION = '5.199';
const VK_API_BASE = process.env.VK_API_BASE || 'https://api.vk.com/method';

async function call(token, method, params = {}) {
  const response = await fetch(`${VK_API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: token, v: VK_API_VERSION }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  return response.json();
}

const OK = '✓';
const NO = '✗';

export async function runCheck() {
  const token = process.env.VK_ACCESS_TOKEN;

  if (!token) {
    console.error(`${NO} VK_ACCESS_TOKEN is not set.`);
    console.error('   Get one with: npx vk-mcp-server --login <APP_ID>');
    process.exit(1);
  }

  console.error(`Checking token (${token.length} characters)…\n`);

  // users.get with no arguments returns the token owner — the cheapest way to
  // learn whether this is a user token and who it belongs to.
  const self = await call(token, 'users.get');

  if (self.error) {
    const { error_code: code, error_msg: msg } = self.error;
    console.error(`${NO} VK rejected the token: error ${code} — ${msg}\n`);
    if (code === 5) console.error('   The token expired or was revoked. Issue a new one: npx vk-mcp-server --login <APP_ID>');
    else if (code === 8) console.error('   The app that issued this token is blocked. Create your own app at https://vk.com/editapp?act=create and issue a fresh token.');
    else if (code === 1051 || code === 28) console.error('   This looks like a service token, which cannot call user methods.');
    process.exit(1);
  }

  let kind = 'unknown';
  if (Array.isArray(self.response) && self.response.length) {
    const me = self.response[0];
    kind = 'user';
    console.error(`${OK} User token — acting as ${me.first_name} ${me.last_name} (id ${me.id})`);
  } else {
    // A community token answers users.get with an empty array; groups.getById
    // with no arguments then names the community it belongs to.
    const group = await call(token, 'groups.getById');
    const found = group.response?.groups?.[0] || group.response?.[0];
    if (found) {
      kind = 'community';
      console.error(`${OK} Community token — acting as "${found.name}" (id ${found.id})`);
    } else {
      kind = 'service';
      console.error(`${OK} Service token — public data only`);
    }
  }

  // Probe what the token can actually reach. Each of these is a read, and each
  // one maps to a group of tools the user would otherwise find broken by trial.
  const probes = [
    ['read public profiles and walls', 'users.get', { user_ids: 'durov' }, 'vk_users_get, vk_wall_get, vk_groups_get_by_id'],
    ['search users and communities', 'groups.search', { q: 'test', count: 1 }, 'vk_users_search, vk_groups_search'],
    ['read your communities', 'groups.get', { count: 1 }, 'vk_groups_get'],
    ['read your friends', 'friends.get', { count: 1 }, 'vk_friends_get'],
    ['read your newsfeed', 'newsfeed.get', { count: 1 }, 'vk_newsfeed_get'],
  ];

  console.error('\nWhat this token can do:\n');
  const blocked = [];
  for (const [label, method, params, tools] of probes) {
    const result = await call(token, method, params);
    if (result.error) {
      console.error(`  ${NO} ${label}  (${tools})`);
      blocked.push({ label, code: result.error.error_code, msg: result.error.error_msg });
    } else {
      console.error(`  ${OK} ${label}`);
    }
  }

  if (blocked.length) {
    console.error('\nWhy some of those are unavailable:');
    const seen = new Set();
    for (const b of blocked) {
      if (seen.has(b.code)) continue;
      seen.add(b.code);
      console.error(`  error ${b.code}: ${b.msg}`);
    }
    if (kind === 'service') {
      console.error('\n  A service token only reaches public data. For the rest, run');
      console.error('  `npx vk-mcp-server --login <APP_ID>` to get a user token.');
    } else if (kind === 'community') {
      console.error('\n  Community tokens act as the community, so they cannot read a person\'s');
      console.error('  friends or newsfeed. That is expected, not a misconfiguration.');
    } else {
      console.error('\n  Re-issue the token with the missing scopes (wall, friends, groups, photos, stats).');
    }
  }

  // Writing is never probed: doing so would post, edit or delete something.
  console.error('\nWrite tools (posting, editing, deleting) are not probed — that would');
  console.error('change something on VK. Try them on a community you own.');
}
