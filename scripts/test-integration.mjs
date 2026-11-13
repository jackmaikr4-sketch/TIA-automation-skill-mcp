import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
const files=fs.readdirSync('tests').filter(f=>f.endsWith('.test.mjs')).map(f=>'tests/'+f);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,TIA_MCP_INTEGRATION:'1'}});
if(result.error)throw result.error;
process.exitCode=result.status??1;
