import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, artifacts } from '../src/runtime.mjs';
const client = new Client({ name: 'tia-contract-export', version: '1.0.0' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      env: process.env,
      args: [path.join(root, 'src', 'server.mjs')],
    }),
  );
  const result = await client.listTools();
  await fs.writeFile(path.join(artifacts, 'tool-manifest.json'), JSON.stringify(result, null, 2));
  console.log(`${result.tools.length} tools exported`);
} finally {
  await client.close();
}
