// Persistent local troubleshooting client. stdin accepts {id,name,arguments} JSON lines.
import readline from 'node:readline';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {root} from '../src/runtime.mjs';
const client=new Client({name:'tia-troubleshooting',version:'1.0.0'});
await client.connect(new StdioClientTransport({command:process.execPath,env:process.env,args:[path.join(root,'src','server.mjs')],stderr:'inherit'}));
console.log(JSON.stringify({ready:true}));
for await(const line of readline.createInterface({input:process.stdin})){
 try{const r=JSON.parse(line);const result=await client.callTool({name:r.name,arguments:r.arguments||{}},undefined,{timeout:210000});console.log(JSON.stringify({id:r.id,...result}));}catch(e){console.log(JSON.stringify({error:e.message}));}
}
await client.close();
