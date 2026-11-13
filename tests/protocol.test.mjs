import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {root} from '../src/runtime.mjs';
import path from 'node:path';
test('real stdio MCP handshake, unique schemas, diagnostic and path/physical rejection',async()=>{
 const client=new Client({name:'tia-protocol-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src','server.mjs')],stderr:'inherit',env:process.env});
 try{
  await client.connect(transport);const {tools}=await client.listTools();
  assert.ok(tools.length>=30);assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  for(const t of tools){assert.match(t.name,/^tia_[a-z_]+$/);assert.ok(t.description.length>20);assert.equal(t.inputSchema.type,'object');}
  if(process.env.TIA_MCP_INTEGRATION==='1'){const diagnostic=await client.callTool({name:'tia_diagnose',arguments:{}});assert.ok(!diagnostic.isError);const info=JSON.parse(diagnostic.content[0].text);assert.equal(info.apiVersion,'18.0.0.0');assert.equal(info.x64,true);}
  const caps=await client.callTool({name:'tia_capabilities',arguments:{}});assert.ok(!caps.isError);assert.equal(JSON.parse(caps.content[0].text).version,'0.2.0');
  const denied=await client.callTool({name:'tia_read_source',arguments:{file:path.join(root,'config.json')}});assert.equal(denied.isError,true);
  const physical=await client.callTool({name:'tia_physical_inspect',arguments:{targetId:'unknown'}});assert.equal(physical.isError,true);assert.match(physical.content[0].text,/not configured/);
 }finally{await client.close();}
});
