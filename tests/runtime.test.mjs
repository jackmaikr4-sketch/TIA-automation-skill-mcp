import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {root,allowed,createFile,sha256,canonicalXml,assertPhysicalTarget,consumePhysical,artifacts,retryBeforeExecution} from '../src/runtime.mjs';
import {latchLad,wireTestCycleIntoMain} from '../src/lad.mjs';
test('project containment rejects traversal, sibling-prefix, ADS, device names and junction escapes',async()=>{
 const base=path.join(root,'projects');
 assert.equal(await allowed(path.join(base,'new','file.scl')),path.join(base,'new','file.scl'));
 for(const f of [path.join(base,'..','config.json'),path.join(base+'-other','file.scl'),'relative.scl',path.join(base,'file.scl:evil'),path.join(base,'NUL.scl')])await assert.rejects(allowed(f));
 const link=path.join(base,'test-junction-'+crypto.randomUUID());await fs.mkdir(base,{recursive:true});
 await fs.symlink(artifacts,link,'junction');try{await assert.rejects(allowed(path.join(link,'file.scl')));}finally{await fs.unlink(link);}
});
test('source overwrite requires current hash and preserves backup',async()=>{
 const file=path.join(root,'projects','test-'+crypto.randomUUID()+'.scl');
 try{await createFile(file,'old');await assert.rejects(createFile(file,'wrong'));await assert.rejects(createFile(file,'wrong','0'.repeat(64)));assert.equal(await fs.readFile(file,'utf8'),'old');
 const result=await createFile(file,'new',sha256('old'));assert.equal(result.sha256,sha256('new'));assert.equal(await fs.readFile(file,'utf8'),'new');}finally{await fs.unlink(file).catch(()=>{});}
});
test('canonical XML ignores only DocumentInfo and line endings',()=>{
 assert.equal(canonicalXml('<DocumentInfo>old</DocumentInfo><X>a</X>\r\n'),canonicalXml('<DocumentInfo>new</DocumentInfo><X>a</X>\n'));
 assert.equal(canonicalXml('\uFEFF<X>a</X>'),canonicalXml('<X>a</X>'));
 assert.notEqual(sha256(canonicalXml('<X>a</X>')),sha256(canonicalXml('<X>b</X>')));
});
test('LAD template uses unique object identifiers and rejects XML injection',()=>{
 const xml=latchLad();assert.match(xml,/ProgrammingLanguage>LAD/);assert.match(xml,/Negated Name="operand"/);
 const ids=[...xml.matchAll(/<(?:Access|Part|Wire)\b[^>]*\bUId="(\d+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
 assert.throws(()=>latchLad('bad<xml'));assert.throws(()=>latchLad('Safe',-1));
});
test('physical operations default to disabled and reject unapproved receipts before network calls',async()=>{
 await assert.rejects(assertPhysicalTarget('unknown'),/not configured/);
 const id=crypto.randomUUID();const folder=path.join(artifacts,'approvals');await fs.mkdir(folder,{recursive:true});const file=path.join(folder,id+'.json');
 await fs.writeFile(file,JSON.stringify({action:'run',approved:false,expiresAt:Date.now()+60000,details:{targetId:'unknown'}}));
 try{await assert.rejects(consumePhysical(id,'run',{targetId:'unknown'}),/approval/);}finally{await fs.unlink(file);}
});
test('test harness refuses nonempty or multi-network Main blocks',()=>{
 const blank='<Name>Main</Name><ProgrammingLanguage>LAD</ProgrammingLanguage><SW.Blocks.CompileUnit><NetworkSource /></SW.Blocks.CompileUnit>';
 assert.match(wireTestCycleIntoMain(blank),/CallInfo Name="MCP_TestCycle"/);
 assert.throws(()=>wireTestCycleIntoMain(blank+'<SW.Blocks.CompileUnit />'));
 assert.throws(()=>wireTestCycleIntoMain(blank.replace('<NetworkSource />','<NetworkSource><Part Name="Contact" /></NetworkSource>')));
});

test('only a definitely unexecuted busy operation is retried',async()=>{
 let attempts=0,mutations=0;
 const result=await retryBeforeExecution(async()=>{attempts++;if(attempts<3)throw Error('MCP_BUSY_BEFORE_EXECUTION: busy');mutations++;return 'saved';},{sleep:async()=>{}});
 assert.equal(result,'saved');assert.equal(attempts,3);assert.equal(mutations,1);
 let uncertainAttempts=0;
 await assert.rejects(retryBeforeExecution(async()=>{uncertainAttempts++;throw Error('TIA operation timed out');}),/timed out/);
 assert.equal(uncertainAttempts,1);
});
