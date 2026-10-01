/**
 * The .mcpb manifest lists the tools for directories that read it without
 * starting the server (Smithery among them). It has to match what the server
 * actually serves — `npm run sync:manifest` rewrites it.
 */

import { describe, it, expect } from '@jest/globals';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('manifest.json', () => {
  it('lists exactly the tools the server serves, with the same descriptions', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'src', 'index.js')],
      env: { ...process.env, VK_ACCESS_TOKEN: '', VK_SERVICE_KEY: '' },
    });
    const client = new Client({ name: 'manifest-test', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();

    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const served = tools.map(({ name, description }) => ({ name, description }));
    // On failure: run `npm run sync:manifest` and commit manifest.json.
    expect(manifest.tools).toEqual(served);
  }, 30000);
});
