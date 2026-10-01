#!/usr/bin/env node
/**
 * Writes the server's tool list into manifest.json.
 *
 * Directories that take the .mcpb bundle read tools from the manifest and do
 * not start the server to ask — Smithery showed an empty tool list for months
 * because the manifest only said tools_generated. tests/manifest.test.js fails
 * when the two drift; this script is the fix it points to.
 *
 *   npm run sync:manifest
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'manifest.json');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'index.js')],
  env: { ...process.env, VK_ACCESS_TOKEN: '', VK_SERVICE_KEY: '' },
  stderr: 'ignore',
});
const client = new Client({ name: 'sync-manifest', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
manifest.tools = tools.map(({ name, description }) => ({ name, description }));
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: ${tools.length} tools`);
