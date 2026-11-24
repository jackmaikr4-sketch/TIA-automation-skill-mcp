import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MotorPanelController, PANEL_ACTIONS, applyStopBarrier } from './controller.mjs';
import { validateMotorPanelConfig, motorPanelKey } from './launch.mjs';

const at = process.argv.indexOf('--config');
if (at < 0 || !path.isAbsolute(process.argv[at + 1] || ''))
  throw Error('An absolute panel configuration file is required');
const file = path.resolve(process.argv[at + 1]);
const launch = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const config = validateMotorPanelConfig(launch.config);
if (
  path.dirname(file) !== path.resolve(launch.runDir) ||
  launch.key !== motorPanelKey(config.name) ||
  !/^[a-f0-9-]{36}$/.test(launch.nonce)
)
  throw Error('Invalid panel launch configuration');
const session = launch.runDir;
const client = new Client({ name: 'tia-motor-panel', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(launch.root, 'src', 'server.mjs')],
  env: { ...process.env, TIA_MCP_CONFIG: launch.mcpConfig },
  stderr: 'pipe',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function invoke(name, args) {
  for (let n = 0; ; n++) {
    const raw = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    const value = JSON.parse(raw.content[0].text);
    if (!raw.isError) return value;
    if (
      n < 3 &&
      (value.code === 'TIA_BUSY' || value.error?.includes('Another MCP instance is running'))
    ) {
      await sleep(150);
      continue;
    }
    throw Error(value.error || '仿真操作失败');
  }
}
const controller = new MotorPanelController(config, { invoke });
async function publish(value) {
  await fs.writeFile(
    path.join(session, 'state.tmp'),
    JSON.stringify({ updatedAt: new Date().toISOString(), ...value }),
  );
  for (let n = 0; ; n++)
    try {
      await fs.rename(path.join(session, 'state.tmp'), path.join(session, 'state.json'));
      break;
    } catch (e) {
      if (n >= 5) throw e;
      await sleep(30);
    }
}
const log = async (value) =>
  fs.appendFile(
    path.join(session, 'events.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n',
  );
const errorState = (message) => ({
  connected: false,
  cpu: 'Unknown',
  closed: false,
  message,
  error: message,
});
let done = false,
  ready = false,
  lastUiAt = Date.now(),
  uiSeen = false;
try {
  await publish(errorState('正在连接本机仿真…'));
  await client.connect(transport);
  await publish(await controller.initialize());
  ready = true;
  await log({ event: 'ready', instance: config.name, writesOnOpen: 0 });
  while (!done) {
    try {
      const heartbeat = JSON.parse(await fs.readFile(path.join(session, 'heartbeat.json'), 'utf8'));
      if (heartbeat.nonce === launch.nonce) {
        lastUiAt = Date.parse(heartbeat.at);
        uiSeen = true;
      }
    } catch {}
    if (Date.now() - lastUiAt > (uiSeen ? 5000 : 30000)) {
      const state = await controller.execute(controller.interacted ? 'shutdown' : 'detach');
      await publish(state);
      await log({ event: 'ui_disappeared', state });
      break;
    }
    const names = (await fs.readdir(session))
      .filter((x) => /^\d{8}\.request\.json$/.test(x))
      .sort();
    const requests = [];
    for (const name of names) {
      try {
        const request = JSON.parse(
          (await fs.readFile(path.join(session, name), 'utf8')).replace(/^\uFEFF/, ''),
        );
        if (
          request.nonce !== launch.nonce ||
          !PANEL_ACTIONS.includes(request.action) ||
          Object.keys(request).some((k) => !['action', 'nonce'].includes(k))
        )
          throw Error('Invalid panel request');
        requests.push({ name, ...request });
      } catch (e) {
        await log({ event: 'invalid_request', name, error: e.message });
        await fs.rename(path.join(session, name), path.join(session, name + '.invalid'));
      }
    }
    const ordered = applyStopBarrier(requests);
    for (const request of ordered.discarded) {
      await log({ event: 'discarded_before_stop', action: request.action });
      await fs.rename(
        path.join(session, request.name),
        path.join(session, request.name + '.discarded'),
      );
    }
    for (const request of ordered.pending) {
      try {
        const state = await controller.execute(request.action);
        await publish(state);
        await log({ event: 'action', action: request.action, ok: true, state });
        done = state.closed === true;
      } catch (e) {
        await publish(errorState(e.message));
        await log({ event: 'action', action: request.action, ok: false, error: e.message });
      }
      await fs.rename(path.join(session, request.name), path.join(session, request.name + '.done'));
      if (done) break;
    }
    if (done) break;
    if (!ordered.pending.length)
      try {
        await publish(await controller.tick());
      } catch (e) {
        await publish(errorState('连接中断：' + e.message));
      }
    await sleep(400);
  }
} catch (e) {
  await publish(errorState(e.message));
  await log({ event: 'fatal', error: e.message, ready });
} finally {
  await client.close();
}
