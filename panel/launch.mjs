import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {z} from 'zod';

const symbolic=z.string().min(1).max(256).refine(s=>s===s.trim()&&!/[\x00-\x1f\x7f]/.test(s)&&!/^%?[IQM]\d/i.test(s),'Use a symbolic PLC tag name, not a raw address');
export const motorPanelConfigSchema=z.object({
 name:z.string().regex(/^CodexMCP_[A-Za-z0-9_]{1,50}$/),
 cpu:z.string().min(1).max(128).refine(s=>!/[\x00-\x1f]/.test(s)),
 title:z.string().min(1).max(80).refine(s=>!/[\x00-\x1f]/.test(s)).default('电机仿真操作面板'),
 tags:z.object({start:symbolic,stopOk:symbolic,jog:symbolic,overloadOk:symbolic,motor:symbolic,latch:symbolic}).strict()
}).strict();
export const canonicalTag=tag=>tag.replaceAll('"','').toUpperCase();
export function validateMotorPanelConfig(value){
 const config=motorPanelConfigSchema.parse(value);
 if(new Set(Object.values(config.tags).map(canonicalTag)).size!==6)throw Error('Motor panel requires six distinct symbols; output and latch may never be writable input roles');
 return config;
}
export function motorPanelKey(name){
 if(!/^CodexMCP_[A-Za-z0-9_]{1,50}$/.test(name))throw Error('Invalid owned simulation name');
 return crypto.createHash('sha256').update(name).digest('hex').slice(0,24);
}
export async function preflightMotorPanel(value,invoke){
 const config=validateMotorPanelConfig(value);
 const listed=await invoke('tia_sim_list',{});
 if(!listed.some(x=>x.name===config.name))throw Error('Owned simulation is not running. Create/download/run it before opening the panel.');
 const state=await invoke('tia_sim_control',{name:config.name,action:'status'});
 if(state.controller!==config.cpu)throw Error('Simulation controller does not match the requested CPU');
 if(state.state!=='Run')throw Error('Simulation must already be in RUN; opening the panel never starts or powers on a CPU');
 const tags=await invoke('tia_sim_tags',{name:config.name});
 for(const [role,name] of Object.entries(config.tags)){
  const matches=tags.filter(t=>canonicalTag(t.name)===canonicalTag(name));
  if(matches.length!==1||matches[0].type!=='Bool')throw Error(`Panel role ${role} must resolve to exactly one Bool symbol: ${name}`);
  config.tags[role]=matches[0].name;
 }
 return {config,state};
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function readJson(file){return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}
async function noLinks(file){
 for(let at=path.resolve(file);;at=path.dirname(at)){
  try{if((await fs.lstat(at)).isSymbolicLink())throw Error('Panel paths must not contain symbolic links or junctions');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(path.dirname(at)===at)break;
 }
}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
const validTicks=value=>typeof value==='string'&&/^\d{18,19}$/.test(value);
const validNonce=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export async function readProcessStartedAtTicks(pid){
 if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0||pid>2147483647)throw Error('A valid Windows process identity is required');
 const script=`$ErrorActionPreference='Stop'; $target=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $target){[Console]::Out.WriteLine('MISSING')}else{[Console]::Out.WriteLine($target.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))}`;
 const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',error='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{error=(error+data).slice(-2000);});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Cannot verify panel process creation time: '+error)));});
 const value=output.trim();if(value==='MISSING')return null;if(!validTicks(value))throw Error('Invalid panel process creation time readback');return value;
}

export function panelEvidenceIsCurrent({registry,launch,ui,heartbeat,processStartedAtTicks,now=Date.now()}){
 if(!validTicks(registry?.processStartedAtTicks)||processStartedAtTicks!==registry.processStartedAtTicks||!validNonce(launch?.nonce)||launch.runDir!==registry.runDir)return false;
 for(const evidence of [ui,heartbeat])if(evidence?.pid!==registry.pid||evidence.nonce!==launch.nonce||evidence.processStartedAtTicks!==registry.processStartedAtTicks)return false;
 const age=now-Date.parse(heartbeat.at);return Number.isFinite(age)&&age>=-1000&&age<=3000;
}

export function validatePanelRegistry(value,{runRoot,key}){
 if(typeof runRoot!=='string'||!path.isAbsolute(runRoot)||!/^[a-f0-9]{24}$/.test(key))throw Error('Invalid trusted panel registry location');
 if(!value||!Number.isSafeInteger(value.pid)||value.pid<=0)throw Error('Invalid panel registry process identity');
 if(!validTicks(value.processStartedAtTicks))throw Error('Panel registry has no verified process creation time; close the old panel before replacing its registration');
 if(typeof value.runDir!=='string'||!path.isAbsolute(value.runDir))throw Error('Invalid panel registry directory');
 const runDir=path.resolve(value.runDir),parent=path.resolve(runRoot);
 if(path.dirname(runDir)!==parent||!new RegExp('^'+key+'-[a-f0-9-]{36}$').test(path.basename(runDir)))throw Error('Panel registry directory must remain under the trusted panel directory');
 for(const [field,name] of Object.entries({configFile:'panel.json',stateFile:'state.json',logFile:'events.jsonl'})){
  if(typeof value[field]!=='string'||!path.isAbsolute(value[field])||path.resolve(value[field])!==path.join(runDir,name))throw Error('Invalid panel registry '+field);
 }
 return {...value,runDir};
}

// The OS owns this mutex, so an interrupted launcher cannot leave a stale disk lock.
// Closing the parent pipe releases it; a second launcher never removes another owner's lock.
export async function acquirePanelLaunchLock(key){
 if(process.platform!=='win32'||!/^[a-f0-9]{24}$/.test(key))throw Error('A Windows panel launch key is required');
 const script=`$ErrorActionPreference='Stop'; $created=$false; $mutex=[Threading.Mutex]::new($true,'Local\\CodexTiaMotorLaunch_${key}',[ref]$created); if(-not $created){$mutex.Dispose();exit 73}; try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$mutex.ReleaseMutex();$mutex.Dispose()}`;
 const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let errorText='',output='',settled=false;
 const closed=new Promise(resolve=>child.once('close',resolve));
 child.stderr.on('data',data=>{errorText=(errorText+data).slice(-2000);});
 child.stdin.on('error',()=>{});
 await new Promise((resolve,reject)=>{
  const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.stdin.end();reject(error);}else resolve();};
  const timer=setTimeout(()=>finish(Error('Timed out while acquiring the native panel launch mutex')),5000);
  child.once('error',finish);
  child.once('close',code=>finish(Error(code===73?'Another request is opening this simulation panel; wait briefly and retry.':'Panel launch mutex failed: '+(errorText||code))));
  child.stdout.on('data',data=>{output+=data;if(output.includes('LOCKED'))finish();});
 });
 let released=false;
 return async()=>{if(released)return;released=true;child.stdin.end('\n');await closed;};
}

// `root` and `runRoot` are internal installation paths, never values copied from tool arguments.
// `invoke` returns parsed MCP results and must reject every isError response.
export async function launchMotorPanel(value,{root,runRoot,invoke}={}){
 if(process.platform!=='win32')throw Error('The native motor panel requires Windows');
 if(typeof root!=='string'||!path.isAbsolute(root)||typeof invoke!=='function')throw Error('Missing trusted panel runtime paths or MCP invocation function');
 runRoot??=path.join(root,'artifacts','panels');
 if(typeof runRoot!=='string'||!path.isAbsolute(runRoot))throw Error('Missing trusted panel runtime paths');
 const {config}=await preflightMotorPanel(value,invoke);
 root=path.resolve(root);runRoot=path.resolve(runRoot);
 await noLinks(runRoot);await fs.mkdir(runRoot,{recursive:true});
 const key=motorPanelKey(config.name),registry=path.join(runRoot,key+'.json');
 const releaseLock=await acquirePanelLaunchLock(key);
 try{
  await noLinks(registry);
  let existing;try{existing=await readJson(registry);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){
   existing=validatePanelRegistry(existing,{runRoot,key});
   for(const field of ['runDir','configFile','stateFile','logFile'])await noLinks(existing[field]);
   const actualStartedAt=await readProcessStartedAtTicks(existing.pid);
   if(actualStartedAt===existing.processStartedAtTicks){
    const previous=await readJson(existing.configFile);
    if(!validNonce(previous.nonce)||previous.key!==key||path.resolve(previous.runDir||'')!==existing.runDir)throw Error('Existing panel launch identity does not match its registration');
    if(JSON.stringify(validateMotorPanelConfig(previous.config))!==JSON.stringify(config))throw Error('A panel for this simulation is already open with a different CPU, title or tag mapping; close it before opening a different mapping.');
    for(const name of ['ui.json','heartbeat.json','activate.request','activation.json'])await noLinks(path.join(existing.runDir,name));
    const requestId=crypto.randomUUID();
    await fs.writeFile(path.join(existing.runDir,'activate.request'),JSON.stringify({nonce:previous.nonce,requestId}));
    for(let n=0;n<40;n++){
     try{
      const [ui,heartbeat,ack]=await Promise.all(['ui.json','heartbeat.json','activation.json'].map(name=>readJson(path.join(existing.runDir,name))));
      if(panelEvidenceIsCurrent({registry:existing,launch:previous,ui,heartbeat,processStartedAtTicks:actualStartedAt})&&ack.requestId===requestId&&ack.nonce===previous.nonce&&ack.pid===existing.pid&&ack.processStartedAtTicks===actualStartedAt){
       let state;try{state=await readJson(existing.stateFile);}catch{}
       const stateAge=Date.now()-Date.parse(state?.updatedAt);
       return {...existing,reused:true,activationRequested:true,activationConfirmed:true,windowCreated:true,connected:state?.connected===true&&stateAge>=-1000&&stateAge<=3000};
      }
     }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
     if(!alive(existing.pid))break;
     await pause(100);
    }
    return {...existing,reused:true,activationRequested:true,activationConfirmed:false,windowCreated:false,pending:true,connected:false,message:'The registered panel process is still present, but its window has not confirmed activation. No second panel was launched.'};
   }
  }
  const runDir=path.join(runRoot,key+'-'+crypto.randomUUID());await fs.mkdir(runDir);
  const configFile=path.join(runDir,'panel.json');
  const launch={config,key,nonce:crypto.randomUUID(),runDir,root,node:process.execPath,backend:path.join(root,'panel','backend.mjs'),mcpConfig:process.env.TIA_MCP_CONFIG||path.join(root,'config.json')};
  await fs.writeFile(configFile,JSON.stringify(launch,null,2),{flag:'wx'});
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-NoProfile','-STA','-WindowStyle','Hidden','-File',path.join(root,'panel','MotorPanel.ps1'),'-ConfigFile',configFile];
  // Windows PowerShell may exit successfully without executing -File when
  // launched with DETACHED_PROCESS. Hidden inherited-console mode runs the GUI.
  const child=spawn(powershell,args,{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  const processStartedAtTicks=await readProcessStartedAtTicks(child.pid);
  if(!processStartedAtTicks)throw Error('The panel process exited before its identity could be recorded; inspect '+runDir);
  const result={reused:false,pid:child.pid,processStartedAtTicks,windowTitle:config.title,configFile,stateFile:path.join(runDir,'state.json'),logFile:path.join(runDir,'events.jsonl'),runDir,visibleRequested:true};
  await fs.writeFile(registry,JSON.stringify(result,null,2));
  for(let n=0;n<60;n++){
   try{
    const ui=await readJson(path.join(runDir,'ui.json'));
    if(ui.nonce!==launch.nonce||ui.pid!==child.pid||ui.processStartedAtTicks!==processStartedAtTicks)throw Error('Panel UI identity mismatch');
    return {...result,windowCreated:true};
   }catch(e){if(e.code!=='ENOENT')throw e;}
   if(!alive(child.pid))throw Error('The panel process exited before creating its window; inspect '+runDir);
   await pause(200);
  }
  return {...result,windowCreated:false,pending:true,message:'Panel startup is still pending; do not launch a second process. Read the returned state/log path.'};
 }finally{await releaseLock();}
}
