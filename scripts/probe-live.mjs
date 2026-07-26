#!/usr/bin/env node
/**
 * Calls every tool against the real VK with whatever token is in the
 * environment, and prints what came back. Not a test: VK's answer depends on
 * the token type, so there is no expected value to assert — the point is to
 * find out which of the nineteen actually work with a token a user is likely
 * to have, and whether the ones that cannot work say so understandably.
 *
 *   VK_ACCESS_TOKEN=... node scripts/probe-live.mjs [--write GROUP_ID]
 *
 * Write tools are skipped unless --write names a community to publish in, and
 * everything published is deleted again before the run ends.
 */
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

const writeArg = process.argv.indexOf('--write');
const GROUP = writeArg !== -1 ? Number(process.argv[writeArg + 1]) : null;

// Public targets, so the run means the same thing from any account.
const DUROV = 1;
const APICLUB = 'apiclub';

/** name, args, and whether it changes anything on VK. */
const PROBES = [
  ['vk_users_get', { user_ids: 'durov', fields: 'city' }],
  ['vk_users_search', { q: 'Иван', count: 3 }],
  ['vk_wall_get', { domain: APICLUB, count: 3 }],
  ['vk_wall_get_by_id', { posts: `-166562603_1` }],
  ['vk_groups_get_by_id', { group_ids: APICLUB, fields: 'members_count' }],
  ['vk_groups_search', { q: 'разработка', count: 3 }],
  ['vk_groups_get_members', { group_id: 166562603, count: 3 }],
  ['vk_groups_get', { user_id: DUROV, count: 3 }],
  ['vk_friends_get', { user_id: DUROV, count: 3 }],
  ['vk_newsfeed_get', { count: 3 }],
  ['vk_photos_get', { owner_id: -166562603, album_id: 'wall', count: 3 }],
  ['vk_likes_get', { type: 'post', owner_id: -166562603, item_id: 1, count: 3 }],
  ['vk_stats_get', { group_id: 166562603 }],
];

const WRITES = (group) => [
  ['vk_wall_post', { owner_id: -group, message: 'vk-mcp-server live probe — this post is deleted moments after it appears.' }],
  ['vk_wall_edit', { owner_id: -group, post_id: '<post>', message: 'vk-mcp-server live probe — edited.' }],
  ['vk_wall_create_comment', { owner_id: -group, post_id: '<post>', message: 'probe comment' }],
  ['vk_photos_upload_wall', { group_id: group, image: 'https://vk.com/images/camera_200.png' }],
  ['vk_groups_join', { group_id: group }],
  ['vk_wall_delete', { owner_id: -group, post_id: '<post>' }],
];

const short = (s, n = 150) => String(s).replace(/\s+/g, ' ').slice(0, n);

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env },
  });
  const client = new Client({ name: 'vk-live-probe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const rows = [];
  const run = async (name, args) => {
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content[0].text;
      const parsed = JSON.parse(text);
      if (res.isError) {
        rows.push({ name, ok: false, detail: short(parsed.error) });
        return null;
      }
      const size = Array.isArray(parsed)
        ? `${parsed.length} items`
        : Array.isArray(parsed.items)
          ? `${parsed.items.length}/${parsed.count ?? '?'} items`
          : short(JSON.stringify(parsed), 80);
      rows.push({ name, ok: true, detail: size });
      return parsed;
    } catch (err) {
      rows.push({ name, ok: false, detail: `protocol: ${short(err.message)}` });
      return null;
    }
  };

  for (const [name, args] of PROBES) await run(name, args);

  if (GROUP) {
    let postId = null;
    for (const [name, args] of WRITES(GROUP)) {
      const filled = Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, v === '<post>' ? postId : v])
      );
      if (filled.post_id === null) {
        rows.push({ name, ok: false, detail: 'skipped: no post to act on' });
        continue;
      }
      const out = await run(name, filled);
      if (name === 'vk_wall_post' && out?.post_id) postId = out.post_id;
    }
  } else {
    for (const [name] of WRITES(0)) rows.push({ name, ok: null, detail: 'skipped: no --write group' });
  }

  await client.close();

  const pad = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const mark = r.ok === null ? '–' : r.ok ? '✓' : '✗';
    console.log(`${mark} ${r.name.padEnd(pad)}  ${r.detail}`);
  }
  const worked = rows.filter((r) => r.ok === true).length;
  console.log(`\n${worked}/${rows.filter((r) => r.ok !== null).length} tools answered with data.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
