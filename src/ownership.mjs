import fs from 'node:fs/promises';
import path from 'node:path';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ManagedSimulations {
  constructor(file) {
    this.file = file;
  }
  async list() {
    const values = JSON.parse(
      await fs.readFile(this.file, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '[]';
        throw error;
      }),
    );
    if (
      !Array.isArray(values) ||
      values.some((name) => typeof name !== 'string' || !/^CodexMCP_[A-Za-z0-9_]{1,50}$/.test(name))
    )
      throw Error('Simulation ownership registry is invalid; refusing simulation writes');
    return [...new Set(values)];
  }
  async assert(name) {
    if (!(await this.list()).includes(name))
      throw Error('This simulation was not created by this MCP');
  }
  async update(change) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let handle;
    const deadline = Date.now() + 5000;
    while (!handle) {
      try {
        handle = await fs.open(lock, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() > deadline)
          throw Error('Simulation ownership registry is busy; no ownership data was overwritten');
        await sleep(50);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      const values = [...new Set(change(await this.list()))];
      const temp = this.file + '.' + process.pid + '.tmp';
      await fs.writeFile(temp, JSON.stringify(values));
      await fs.rename(temp, this.file);
      return values;
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }
  add(name) {
    return this.update((names) => [...names, name]);
  }
  remove(name) {
    return this.update((names) => names.filter((value) => value !== name));
  }
}
