import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {validateMotorPanelConfig,preflightMotorPanel,motorPanelKey,validatePanelRegistry,acquirePanelLaunchLock,panelEvidenceIsCurrent,readProcessStartedAtTicks,launchMotorPanel} from '../panel/launch.mjs';
import {MotorPanelController,applyStopBarrier} from '../panel/controller.mjs';

const config={name:'CodexMCP_PanelTest',cpu:'Test_CPU',tags:{start:'Start',stopOk:'Stop_OK',jog:'Jog',overloadOk:'FR_OK',motor:'Motor',latch:'State.Latch'}};
function fixture({running=false}={}){
 const calls=[],values={Start:false,Stop_OK:true,Jog:false,FR_OK:true,Motor:running,'State.Latch':running};
 let controller='Test_CPU',state='Run',time=0;
 const cycle=()=>{values['State.Latch']=values.Stop_OK&&values.FR_OK&&(values.Start||values['State.Latch']);values.Motor=values.Stop_OK&&values.FR_OK&&(values['State.Latch']||values.Jog);};
 const invoke=async(name,args)=>{
  calls.push({name,args});
  if(name==='tia_sim_list')return [{name:config.name}];
  if(name==='tia_sim_control'){assert.equal(args.action,'status');return {controller,state,type:'CPU 1511-1 PN'};}
  if(name==='tia_sim_tags')return Object.keys(values).map(name=>({name,type:'Bool'}));
  if(name==='tia_sim_read'){assert.ok(args.tag in values);return {value:values[args.tag]};}
  if(name==='tia_sim_write'){assert.ok(args.tag in values);assert.equal(typeof args.value,'boolean');values[args.tag]=args.value;cycle();return {value:values[args.tag]};}
  throw Error('Unexpected tool: '+name);
 };
 const motor=new MotorPanelController(config,{invoke,sleep:async ms=>{time+=ms;cycle();},now:()=>time});
 return {motor,invoke,calls,values,advance(ms){time+=ms;},setController(value){controller=value;},setState(value){state=value;}};
}
const writes=f=>f.calls.filter(c=>c.name==='tia_sim_write');

test('panel configuration only accepts explicit owned target and six distinct symbolic roles',()=>{
 assert.equal(validateMotorPanelConfig(config).title,'电机仿真操作面板');
 assert.throws(()=>validateMotorPanelConfig({...config,name:'Physical_CPU'}));
 assert.throws(()=>validateMotorPanelConfig({...config,tags:{...config.tags,start:'%Q0.1'}}));
 assert.throws(()=>validateMotorPanelConfig({...config,tags:{...config.tags,start:'"motor"'}}));
 assert.throws(()=>validateMotorPanelConfig({...config,command:'powershell'}));
 assert.throws(()=>validateMotorPanelConfig({...config,tags:{...config.tags,other:'Extra'}}));
 assert.equal(motorPanelKey(config.name),motorPanelKey(config.name));
 assert.notEqual(motorPanelKey(config.name),motorPanelKey('CodexMCP_Another'));
});

test('panel preflight is read-only and rejects STOP or identity mismatch',async()=>{
 const f=fixture({running:true});
 const checked=await preflightMotorPanel(config,f.invoke);
 assert.equal(checked.config.tags.motor,'Motor');
 assert.equal(writes(f).length,0);
 f.setState('Stop');await assert.rejects(preflightMotorPanel(config,f.invoke),/already be in RUN/);
 f.setState('Run');f.setController('Other');await assert.rejects(preflightMotorPanel(config,f.invoke),/does not match/);
 assert.equal(writes(f).length,0);
});

test('opening an already-running motor never resets its inputs or latch',async()=>{
 const f=fixture({running:true});const state=await f.motor.initialize();
 assert.equal(state.motor,true);assert.equal(state.latch,true);assert.equal(writes(f).length,0);
 await assert.rejects(f.motor.write('motor',false),/只允许/);
 await assert.rejects(f.motor.write('latch',false),/只允许/);
 assert.equal(writes(f).length,0);
});

test('start pulse and stop operate only the four permitted input roles',async()=>{
 const f=fixture();await f.motor.initialize();
 assert.equal((await f.motor.execute('start')).motor,true);
 assert.equal(f.values.Start,false);
 const stopped=await f.motor.execute('stop');assert.equal(stopped.motor,false);assert.equal(stopped.latch,false);
 assert.ok(writes(f).every(c=>['Start','Stop_OK','Jog','FR_OK'].includes(c.args.tag)));
});

test('a failed start write is followed by release even when the failure may have applied the value',async()=>{
 const f=fixture();let rejected=false;
 const invoke=async(name,args)=>{const result=await f.invoke(name,args);if(name==='tia_sim_write'&&args.tag==='Start'&&args.value&&!rejected){rejected=true;throw Error('uncertain write');}return result;};
 const motor=new MotorPanelController(config,{invoke,sleep:async()=>{}});
 await motor.initialize();await assert.rejects(motor.execute('start'),/uncertain write/);
 assert.equal(f.values.Start,false);
 assert.deepEqual(writes(f).filter(c=>c.args.tag==='Start').map(c=>c.args.value),[true,false]);
});

test('a stop pulse releases the normally closed input after an uncertain write failure',async()=>{
 const f=fixture({running:true});let rejected=false;
 const invoke=async(name,args)=>{const result=await f.invoke(name,args);if(name==='tia_sim_write'&&args.tag==='Stop_OK'&&!args.value&&!rejected){rejected=true;throw Error('uncertain stop write');}return result;};
 const motor=new MotorPanelController(config,{invoke,sleep:async()=>{}});
 await motor.initialize();await assert.rejects(motor.execute('stop'),/uncertain stop write/);
 assert.equal(f.values.Stop_OK,true);assert.equal(f.values.Motor,false);assert.equal(f.values['State.Latch'],false);
 assert.deepEqual(writes(f).filter(c=>c.args.tag==='Stop_OK').map(c=>c.args.value),[false,true]);
});

test('command release still attempts jog release after a failed start release',async()=>{
 const f=fixture();f.values.Jog=true;
 const invoke=async(name,args)=>{if(name==='tia_sim_write'&&args.tag==='Start')throw Error('release failed');return f.invoke(name,args);};
 const motor=new MotorPanelController(config,{invoke,sleep:async()=>{}});
 await motor.initialize();await assert.rejects(motor.execute('stop'),/release failed/);
 assert.equal(f.values.Jog,false);
});

test('restoring overload releases held commands before clearing the fault',async()=>{
 const f=fixture();await f.motor.initialize();await f.motor.execute('start');
 await f.motor.execute('overload_on');
 f.values.Start=true;f.values.Jog=true;
 const at=writes(f).length;const state=await f.motor.execute('overload_off');
 assert.equal(state.motor,false);assert.equal(state.latch,false);
 assert.deepEqual(writes(f).slice(at).map(c=>[c.args.tag,c.args.value]),[['Start',false],['Jog',false],['FR_OK',true]]);
});

test('jog releases on request and on watchdog without setting the latch',async()=>{
 const f=fixture();await f.motor.initialize();
 let state=await f.motor.execute('jog_on');assert.equal(state.motor,true);assert.equal(state.latch,false);
 state=await f.motor.execute('jog_off');assert.equal(state.motor,false);
 await f.motor.execute('jog_on');f.advance(30001);state=await f.motor.tick();assert.equal(state.motor,false);assert.equal(state.inputs.jog,false);
});

test('stop barriers discard old queued starts while preserving later deliberate commands',()=>{
 const queue=[{action:'start'},{action:'jog_on'},{action:'stop'},{action:'start'}];
 const result=applyStopBarrier(queue);
 assert.deepEqual(result.discarded.map(x=>x.action),['start','jog_on']);
 assert.deepEqual(result.pending.map(x=>x.action),['stop','start']);
});

test('a stop queued after overload preserves the fault and releases motor state',async()=>{
 const f=fixture({running:true});await f.motor.initialize();
 const queued=[{action:'start'},{action:'overload_on'},{action:'jog_off'},{action:'stop'}];
 const result=applyStopBarrier(queued);
 assert.deepEqual(result.discarded.map(x=>x.action),['start']);
 assert.deepEqual(result.pending.map(x=>x.action),['overload_on','jog_off','stop']);
 for(const request of result.pending)await f.motor.execute(request.action);
 assert.equal(f.values.FR_OK,false);assert.equal(f.values.Motor,false);assert.equal(f.values['State.Latch'],false);
});

test('later stop barriers preserve explicit overload recovery and an earlier shutdown',()=>{
 const queue=[{action:'jog_on'},{action:'overload_on'},{action:'overload_off'},{action:'shutdown'},{action:'stop'}];
 const result=applyStopBarrier(queue);
 assert.deepEqual(result.discarded.map(x=>x.action),['jog_on']);
 assert.deepEqual(result.pending.map(x=>x.action),['overload_on','overload_off','shutdown','stop']);
});

test('identity is verified immediately before each action and a changed target receives no write',async()=>{
 const f=fixture();await f.motor.initialize();f.setController('Other_CPU');
 await assert.rejects(f.motor.execute('jog_on'),/不一致/);assert.equal(writes(f).length,0);
});

test('shutdown confirms motor and latch are false; detach remains read-only',async()=>{
 const f=fixture({running:true});await f.motor.initialize();
 const detached=await f.motor.execute('detach');assert.equal(detached.closed,true);assert.equal(writes(f).length,0);assert.equal(f.values.Motor,true);
 const stopped=await f.motor.execute('shutdown');assert.equal(stopped.closed,true);assert.equal(stopped.motor,false);assert.equal(stopped.latch,false);
});

test('panel registry cannot redirect reads or activation writes outside its trusted session',()=>{
 const runRoot=path.resolve(import.meta.dirname,'../artifacts/panel-test'),key=motorPanelKey(config.name);
 const runDir=path.join(runRoot,key+'-00000000-0000-4000-8000-000000000000');
 const registry={pid:process.pid,processStartedAtTicks:'638000000000000000',runDir,configFile:path.join(runDir,'panel.json'),stateFile:path.join(runDir,'state.json'),logFile:path.join(runDir,'events.jsonl')};
 const opts={runRoot,key};
 assert.equal(validatePanelRegistry(registry,opts).runDir,runDir);
 for(const pid of [0,-1,1.5,'123',null])assert.throws(()=>validatePanelRegistry({...registry,pid},opts),/process identity/);
 assert.throws(()=>validatePanelRegistry({...registry,runDir:path.dirname(runRoot)},opts),/trusted panel directory/);
 assert.throws(()=>validatePanelRegistry({...registry,runDir:runRoot},opts),/trusted panel directory/);
 assert.throws(()=>validatePanelRegistry({...registry,runDir:path.join(runRoot,'unrelated')},opts),/trusted panel directory/);
 for(const field of ['configFile','stateFile','logFile'])assert.throws(()=>validatePanelRegistry({...registry,[field]:path.join(runRoot,'outside.json')},opts),/Invalid panel registry/);
 assert.throws(()=>validatePanelRegistry({...registry,processStartedAtTicks:undefined},opts),/process creation time/);
});

test('reused PID, stale heartbeat and mismatched window nonce never prove an existing panel is current',()=>{
 const now=Date.now(),ticks='638000000000000000',nonce='00000000-0000-4000-8000-000000000000';
 const registry={pid:1234,runDir:path.resolve('panel-test'),processStartedAtTicks:ticks};
 const launch={runDir:registry.runDir,nonce};
 const ui={pid:1234,nonce,processStartedAtTicks:ticks};
 const heartbeat={...ui,at:new Date(now).toISOString()};
 const evidence={registry,launch,ui,heartbeat,processStartedAtTicks:ticks,now};
 assert.equal(panelEvidenceIsCurrent(evidence),true);
 assert.equal(panelEvidenceIsCurrent({...evidence,processStartedAtTicks:'638000000000000001'}),false);
 assert.equal(panelEvidenceIsCurrent({...evidence,heartbeat:{...heartbeat,at:new Date(now-3001).toISOString()}}),false);
 assert.equal(panelEvidenceIsCurrent({...evidence,heartbeat:{...heartbeat,at:new Date(now+1001).toISOString()}}),false);
 assert.equal(panelEvidenceIsCurrent({...evidence,heartbeat:{...heartbeat,at:'invalid'}}),false);
 assert.equal(panelEvidenceIsCurrent({...evidence,heartbeat:{...heartbeat,pid:1235}}),false);
 assert.equal(panelEvidenceIsCurrent({...evidence,ui:{...ui,nonce:'11111111-1111-4111-8111-111111111111'}}),false);
 assert.equal(panelEvidenceIsCurrent({...evidence,ui:undefined}),false);
});

test('Windows process identity includes creation time and missing PIDs return null',{skip:process.platform!=='win32'},async()=>{
 const first=await readProcessStartedAtTicks(process.pid),second=await readProcessStartedAtTicks(process.pid);
 assert.match(first,/^\d{18,19}$/);assert.equal(first,second);
 assert.equal(await readProcessStartedAtTicks(2147483647),null);
});

test('native launcher really executes its PowerShell script instead of exiting silently',{skip:process.platform!=='win32'},async(t)=>{
 const testRoot=await fs.mkdtemp(path.join(os.tmpdir(),'tia-panel-launch-test-'));
 await fs.mkdir(path.join(testRoot,'panel'));
 const script=`param([string]$ConfigFile)\n$launch=[IO.File]::ReadAllText($ConfigFile)|ConvertFrom-Json\n$ui=@{pid=$PID;nonce=$launch.nonce;processStartedAtTicks=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}\n[IO.File]::WriteAllText((Join-Path $launch.runDir 'ui.json'),($ui|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))\nStart-Sleep -Seconds 2\n`;
 await fs.writeFile(path.join(testRoot,'panel','MotorPanel.ps1'),script);
 t.after(async()=>{await new Promise(resolve=>setTimeout(resolve,2200));assert.equal(path.dirname(testRoot),path.resolve(os.tmpdir()));assert.ok(path.basename(testRoot).startsWith('tia-panel-launch-test-'));await fs.rm(testRoot,{recursive:true,force:true});});
 const f=fixture();
 const launched=await launchMotorPanel(config,{root:testRoot,invoke:f.invoke});
 assert.equal(launched.windowCreated,true);assert.equal(launched.reused,false);assert.equal(writes(f).length,0);
 const ui=JSON.parse(await fs.readFile(path.join(launched.runDir,'ui.json'),'utf8'));
 assert.equal(ui.pid,launched.pid);assert.equal(ui.processStartedAtTicks,launched.processStartedAtTicks);
});

test('native launch mutex rejects concurrent owners and releases without persistent lock files',{skip:process.platform!=='win32'},async(t)=>{
 const key=motorPanelKey('CodexMCP_LockTest_'+process.pid);
 const release=await acquirePanelLaunchLock(key);t.after(release);
 await assert.rejects(acquirePanelLaunchLock(key),/Another request is opening/);
 await release();
 const again=await acquirePanelLaunchLock(key);t.after(again);await again();
});

test('native panel script preserves UTF-8 BOM and parses in Windows PowerShell 5.1',{skip:process.platform!=='win32'},async()=>{
 const script=path.resolve(import.meta.dirname,'../panel/MotorPanel.ps1');
 const buffer=await fs.readFile(script);assert.deepEqual([...buffer.subarray(0,3)],[0xef,0xbb,0xbf]);
 const quoted=script.replaceAll("'","''");
 const result=spawnSync('powershell.exe',['-NoProfile','-Command',`$t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|Out-String|Write-Output;exit 1}`],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
