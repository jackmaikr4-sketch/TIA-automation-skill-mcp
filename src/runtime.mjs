import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { z } from 'zod';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuration = z.object({
  tiaApiDirectory: z.string(),
  simulationApiDirectory: z.string(),
  allowedRoots: z.array(z.string()).min(1),
  operationTimeoutMs: z.number().int().min(1000).max(600000),
  physicalTargets: z.array(
    z.object({
      id: z.string().min(1),
      address: z.string().ip({ version: 'v4' }),
      serial: z.string().min(1),
      model: z.string().min(1),
      firmware: z.string().regex(/^\d+\.\d+\.\d+$/),
      rack: z.number().int().min(0).max(7).default(0),
      slot: z.number().int().min(0).max(31).default(1),
    }),
  ),
  snap7Library: z.string(),
  simulationNetwork: z
    .object({
      communication: z.enum(['TCPIP', 'Softbus']),
      adapter: z.literal('Siemens PLCSIM Virtual Ethernet Adapter'),
      hostAddress: z.string().ip({ version: 'v4' }),
      address: z.string().ip({ version: 'v4' }),
      mask: z.string().ip({ version: 'v4' }),
    })
    .optional(),
});
export const config = configuration.parse(
  JSON.parse(
    await fs.readFile(process.env.TIA_MCP_CONFIG || path.join(root, 'config.json'), 'utf8'),
  ),
);
export const artifacts = path.join(root, 'artifacts');
await fs.mkdir(artifacts, { recursive: true });
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export async function allowed(file, roots = config.allowedRoots) {
  if (typeof file !== 'string' || !path.isAbsolute(file))
    throw Error('An absolute project path is required');
  const resolved = path.resolve(file);
  if (
    process.platform === 'win32' &&
    (/[:]/.test(resolved.slice(2)) ||
      resolved.startsWith('\\\\') ||
      resolved
        .split(path.sep)
        .slice(1)
        .some(
          (part) =>
            /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ))
  )
    throw Error('Device, UNC, alternate stream and ambiguous paths are not allowed');
  if (
    !roots.some((r) => {
      const rel = path.relative(path.resolve(r), resolved);
      return (
        rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
      );
    })
  )
    throw Error('Path outside configured project roots');
  // Reject junctions and symlinks, including intermediate ancestors.
  let current = resolved;
  while (true) {
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw Error('Symlink/junction paths are not allowed');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}
export async function createFile(file, text, expectedSha256) {
  file = await allowed(file);
  let previous;
  try {
    previous = await fs.readFile(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (previous) {
    if (!expectedSha256 || sha256(previous) !== expectedSha256)
      throw Error('Existing file requires matching expectedSha256');
    await fs.writeFile(
      path.join(artifacts, `${Date.now()}-${crypto.randomUUID()}.backup`),
      previous,
      { flag: 'wx' },
    );
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (previous) await fs.writeFile(file, text, 'utf8');
  else await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  return { file, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}
export class WorkerClient {
  constructor() {
    this.pending = new Map();
    this.seq = 0;
    this.failed = false;
  }
  start() {
    if (this.failed)
      throw Error('Worker stopped unexpectedly. Restart MCP; do not retry writes blindly.');
    if (this.child) return;
    let executable = 'TiaWorker.exe';
    const manifest = path.join(root, 'bin', 'current.json');
    if (fsSync.existsSync(manifest)) {
      executable = JSON.parse(fsSync.readFileSync(manifest, 'utf8')).executable;
      if (!/^TiaWorker-[a-f0-9]{12}\.exe$/.test(executable))
        throw Error('Invalid worker build manifest');
    }
    this.child = spawn(path.join(root, 'bin', executable), [], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        TIA_API_DIR: config.tiaApiDirectory,
        TIA_SIM_API_DIR: config.simulationApiDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => process.stderr.write(d));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        process.stderr.write(`Worker non-JSON output: ${line.slice(0, 200)}\n`);
        return;
      }
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      r.ok
        ? p.resolve(r.value)
        : p.reject(Object.assign(Error(r.error), { workerType: r.type, details: r.details }));
    });
    const stop = (e) => {
      this.failed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    };
    this.child.stdin.on('error', stop);
    this.child.on('error', stop);
    this.child.on('exit', (code) => {
      stop(Error(`Worker exited (${code}); changes may be partial, inspect project and backups.`));
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    });
  }
  call(op, args = {}) {
    return retryBeforeExecution(() => this.callOnce(op, args));
  }
  callOnce(op, args = {}) {
    this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failed = true;
        reject(
          Error(
            'TIA operation timed out. Do not repeat the operation; inspect pending TIA dialogs and restart MCP.',
          ),
        );
        this.child.kill();
      }, config.operationTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }
  close() {
    this.child?.stdin.end();
  }
}
export async function retryBeforeExecution(
  operation,
  { maxWaitMs = 2500, delayMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  const started = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      // The worker emits this marker only before Execute. Never retry timeouts,
      // transport failures or errors from an operation that may have mutated TIA.
      if (
        !error.message?.startsWith('MCP_BUSY_BEFORE_EXECUTION') ||
        Date.now() - started >= maxWaitMs
      )
        throw error;
      await sleep(delayMs);
    }
  }
}
export async function audit(tool, status, details = {}) {
  await fs.appendFile(
    path.join(artifacts, 'audit.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), tool, status, ...details }) + '\n',
  );
}
export function canonicalXml(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/<DocumentInfo>[\s\S]*?<\/DocumentInfo>/g, '')
    .replace(/\r\n/g, '\n');
}
export async function assertPhysicalTarget(id) {
  const target = config.physicalTargets.find((t) => t.id === id);
  if (!target)
    throw Error('Physical target is not configured. No network scans or writes were performed.');
  if (!target.serial || !target.model || !target.address || !target.firmware)
    throw Error('Physical target must specify address, serial, model and firmware');
  return target;
}
export async function preparePhysical(targetId, action, details) {
  const target = await assertPhysicalTarget(targetId);
  const id = crypto.randomUUID();
  const request = { id, target, action, details, expiresAt: Date.now() + 300000, approved: false };
  await fs.mkdir(path.join(artifacts, 'approvals'), { recursive: true });
  await fs.writeFile(
    path.join(artifacts, 'approvals', id + '.json'),
    JSON.stringify(request, null, 2),
    { flag: 'wx' },
  );
  return {
    id,
    target,
    action,
    details,
    expiresAt: request.expiresAt,
    approved: false,
    instruction: `Ask the user for this specific physical action, then have the user run scripts/approve-physical.ps1 -Id ${id}. Never approve it yourself.`,
  };
}
export async function consumePhysical(id, action, details) {
  const file = path.join(artifacts, 'approvals', id + '.json');
  const r = JSON.parse(await fs.readFile(file, 'utf8'));
  if (
    r.action !== action ||
    !r.approved ||
    r.expiresAt < Date.now() ||
    JSON.stringify(r.details) !== JSON.stringify(details)
  )
    throw Error('Physical approval is missing, expired or does not match this exact action');
  const target = await assertPhysicalTarget(r.target.id);
  if (JSON.stringify(target) !== JSON.stringify(r.target))
    throw Error('Target changed since approval');
  await fs.rename(file, file + '.used');
  return target;
}
