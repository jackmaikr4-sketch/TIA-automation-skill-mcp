import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ManagedSimulations} from '../src/ownership.mjs';

test('concurrent MCP clients preserve all ownership entries and deduplicate retries',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tia-owned-')),file=path.join(folder,'managed.json');
 const clients=[new ManagedSimulations(file),new ManagedSimulations(file),new ManagedSimulations(file)];
 try{
  await Promise.all(clients.map((client,i)=>client.add('CodexMCP_Test'+i)));
  await clients[0].add('CodexMCP_Test0');
  assert.deepEqual((await clients[0].list()).sort(),['CodexMCP_Test0','CodexMCP_Test1','CodexMCP_Test2']);
  await clients[1].remove('CodexMCP_Test1');await assert.rejects(clients[2].assert('CodexMCP_Test1'));
  await clients[2].assert('CodexMCP_Test2');
 }finally{await fs.unlink(file).catch(()=>{});await fs.rmdir(folder);}
});
