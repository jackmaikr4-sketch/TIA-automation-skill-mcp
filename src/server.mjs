import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {root,config,artifacts,allowed,createFile,sha256,WorkerClient,audit,canonicalXml,preparePhysical,consumePhysical,assertPhysicalTarget} from './runtime.mjs';
import {latchLad} from './lad.mjs';
import {ProjectAccess,classifyToolError} from './project-access.mjs';
import {ManagedSimulations} from './ownership.mjs';
import {createSimulationWorkflow,validateSimulationValue,simulationLimits,assertSimulationDownloadTarget} from './simulation.mjs';
import {launchMotorPanel,motorPanelConfigSchema,canonicalTag} from '../panel/launch.mjs';
const worker=new WorkerClient();
const server=new McpServer({name:'tia-mcp',version:'0.2.0'});
const projectAccess=new ProjectAccess();
const handlers=new Map();let connectedPid=null;
const file=z.string().min(3).describe('Absolute path inside configured allowedRoots');
const cpu=z.string().default('').describe('PLC software or CPU name; blank only if exactly one PLC exists');
const instance=z.string().regex(/^CodexMCP_[A-Za-z0-9_]{1,50}$/);
let queue=Promise.resolve();
const projectOps=new Set(['add_device','import_xml','import_scl','add_tag','save','download','compile_save','blocks','tags','export_block','compile','interfaces','online','project','show_block','show_device','backup','close_project','enable_simulation','initialize_test_security','test_network','prepare_new_plc_simulation','device_attributes','cpu_network']);
async function call(op,args={}){
 if(projectOps.has(op)){
  const p=await worker.call('project');await projectAccess.assert(p.path);
  return worker.call(op,{...args,expectedProjectPath:p.path});
 }
 return worker.call(op,args);
}
function tool(name,description,inputSchema,fn,readOnly=false){
 handlers.set(name,{fn,schema:z.object(inputSchema)});
 server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:false}},args=>{
  const job=queue.then(async()=>{try{
   const result=await fn(args);await audit(name,result?.success===false?'error':'ok');
   return {isError:result?.success===false,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result&&typeof result==='object'&&!Array.isArray(result)?result:{result}};
  }catch(e){const failure=classifyToolError(e);await audit(name,'error',failure);return {isError:true,content:[{type:'text',text:JSON.stringify(failure)}],structuredContent:failure};}});
  queue=job.catch(()=>{});return job;
 });
}
async function invoke(name,args={}){const handler=handlers.get(name);if(!handler)throw Error('Unknown internal MCP operation: '+name);return handler.fn(handler.schema.parse(args));}
async function compileReport(result){const reportFile=path.join(artifacts,'compile-'+crypto.randomUUID()+'.json');await fs.writeFile(reportFile,JSON.stringify({at:new Date().toISOString(),project:await worker.call('project'),...result},null,2),{flag:'wx'});return {...result,reportFile};}
tool('tia_diagnose','Inspect local TIA V18 API and current token permissions. Does not prove project/license/simulation availability.',{},async()=>({...await worker.call('diagnose'),allowedRoots:config.allowedRoots,physicalTargets:config.physicalTargets.map(t=>({id:t.id,model:t.model,address:t.address})),capabilities:{offline:'implemented; see acceptance.json for verification',simulation:'PLCSIM Advanced S7-1500 API; license required',physical:'not hardware validated'}}),true);
tool('tia_capabilities','Describe supported direct API workflows, current tool version, prerequisites and known limits. No screenshots or TIA changes are required.',{},async()=>({name:'tia-mcp',version:'0.2.0',engineeringBackend:'Siemens TIA V18 Openness',simulationBackend:'PLCSIM Advanced S7-1500',defaultSimulationCommunication:'Softbus',workflows:{program:['tia_connect','tia_project_info','tia_write_source','tia_import_scl or tia_import_lad_xml','tia_compile_save'],view:['tia_show_block','tia_show_device'],simulate:['tia_sim_prepare_download','tia_sim_tags','tia_sim_verify'],buttons:['tia_sim_pulse','tia_sim_open_motor_panel']},limits:simulationLimits,prerequisites:['Installed licensed TIA V18 and PLCSIM Advanced','Siemens Openness membership and first-connection authorization','Keep the owning MCP connection or motor panel open during simulation'],limitations:['S7-1200 standard PLCSIM backend is not implemented','Physical PLC operations have not been hardware validated','Existing unsaved user work requires an explicit user save before modifications','A motor panel requires four Bool input tags, a Bool output and a Bool latch'] ,toolNames:[...handlers.keys()]}),true);
tool('tia_list_instances','List available TIA Portal processes without opening or modifying a project.',{},()=>worker.call('processes'),true);
tool('tia_connect','Attach to an explicit TIA pid, or launch a new visible V18 session. Reconnecting to the same pid is idempotent. Use tia_disconnect before switching; never closes existing projects.',{pid:z.number().int().positive().optional()},async a=>{const result=await worker.call('connect',{...a,backupRoot:path.join(artifacts,'backups')});if(connectedPid!==result.pid)projectAccess.clear();connectedPid=result.pid;return result;});
tool('tia_disconnect','Release only the Openness connection so another TIA session can be attached. Keeps the TIA window and open project intact, including unsaved changes; clears temporary project access.',{},async()=>{const result=await worker.call('disconnect');projectAccess.clear();connectedPid=null;return result;});
tool('tia_authorize_attached_project','Grant this MCP connection access to the exact attached .ap18 project the user requested. The path must match the open project. Does not change persistent roots or grant source-file access.',{file:z.string().min(3).describe('Exact absolute .ap18 path returned by tia_connect or tia_project_info')},async a=>{const project=await worker.call('project');return projectAccess.grant(a.file,project.path);});
tool('tia_open_project','Open a permitted .ap18 project only if this session has no project. Never closes existing work.',{file},async a=>{const f=await allowed(a.file);if(path.extname(f).toLowerCase()!=='.ap18')throw Error('Expected .ap18');return worker.call('open',{file:f});});
tool('tia_create_project','Create a new V18 project within permitted project roots.',{directory:file,name:z.string().regex(/^[\p{L}\p{N}_ -]{1,64}$/u)},async a=>{const directory=await allowed(a.directory);await fs.mkdir(directory,{recursive:true});return worker.call('create',{...a,directory});});
tool('tia_project_info','Read open project metadata, devices, CPU names, unsaved state and access scope. Metadata remains readable outside configured roots; edits still require exact project access.',{},async()=>{const project=await worker.call('project');return {...project,access:await projectAccess.inspect(project.path)};},true);
tool('tia_backup_project','Archive a saved permitted project. An unsaved MCP batch reuses its verified pre-change checkpoint; pre-existing unsaved user projects are rejected.',{},async()=>{const p=await worker.call('project');await projectAccess.assert(p.path);return {backup:await worker.call('backup',{expectedProjectPath:p.path}),currentUnsavedIncluded:!p.isModified};});
tool('tia_save_project','Save current permitted project with its verified pre-change archive. Refuses pre-existing unsaved projects with no MCP checkpoint.',{},()=>call('save'));
tool('tia_close_project','Close only an MCP-created TIA session project with no unsaved changes; never closes an attached user project.',{},async()=>{const result=await call('close_project');projectAccess.clear();return result;});
tool('tia_end_owned_session','Release an MCP-created TIA session only after its project has been explicitly saved and closed. Never ends a user-attached session.',{},()=>worker.call('end_session'));
tool('tia_enable_simulation','Back up and enable Support simulation during block compilation for the permitted project.',{},()=>call('enable_simulation'));
tool('tia_add_device','Back up and create a device from an exact installed hardware catalog typeIdentifier. Never guesses firmware.',{typeIdentifier:z.string().min(1),name:z.string().min(1),itemName:z.string().min(1)},a=>call('add_device',a));
tool('tia_initialize_test_security','Initialize a new confidential-configuration password only in an isolated MCP_V18_ acceptance project. Refuses existing protection; saves a random password with Windows CurrentUser DPAPI, never plaintext.',{cpu},async a=>{const p=await call('project');if(!p.path.toLowerCase().startsWith(path.join(root,'projects','acceptance').toLowerCase()+path.sep)||!p.name.startsWith('MCP_V18_'))throw Error('Not an isolated acceptance project');return call('initialize_test_security',a);});
tool('tia_configure_test_network','Set only an isolated acceptance CPU network address to the configured private PLCSIM test network. Does not configure physical adapters.',{cpu},async a=>{const n=config.simulationNetwork;if(!n)throw Error('No isolated simulation network configured');return call('test_network',{...a,address:n.address,mask:n.mask});});
tool('tia_prepare_new_plc_for_simulation','Prepare a project created in this MCP session for isolated PLCSIM use: archive, enable simulation, set FullAccess lab access, create a DPAPI-encrypted random configuration password and configure the dedicated virtual subnet. Refuses existing device passwords; never downloads to physical hardware.',{cpu},async a=>{const n=config.simulationNetwork;if(!n)throw Error('Configure the dedicated simulation network first');return call('prepare_new_plc_simulation',{...a,address:n.address,mask:n.mask});});
tool('tia_list_blocks','List PLC blocks recursively including language and consistency.',{cpu},a=>call('blocks',a),true);
tool('tia_device_attributes','Read offline CPU attribute names, types and non-secret values for diagnosing hardware compile errors. Password/secret values are redacted.',{cpu},a=>call('device_attributes',a),true);
tool('tia_cpu_network','Read the selected offline CPU network nodes, configured addresses, masks and subnets without changing the project or host adapters.',{cpu},a=>call('cpu_network',a),true);
tool('tia_show_block','Open an existing PLC block directly in the TIA editor through Siemens Openness. No screenshots, mouse coordinates or program edits are used.',{cpu,block:z.string().min(1)},a=>call('show_block',a));
tool('tia_show_device','Display the selected CPU station in the TIA device or network editor through Siemens Openness, without changing hardware configuration.',{cpu,view:z.enum(['Device','Network']).default('Device')},a=>call('show_device',a));
tool('tia_export_block','Export a PLC block (including LAD/SCL) as XML and return contents plus canonical SHA256 for guarded replacement.',{cpu,block:z.string().min(1)},async a=>{
 const f=path.join(artifacts,`block-${crypto.randomUUID()}.xml`);const result=await call('export_block',{...a,file:f});const xml=await fs.readFile(f,'utf8');return {...result,xml,sha256:sha256(canonicalXml(xml))};
},true);
tool('tia_read_source','Read a source/XML file inside permitted roots with SHA256.',{file},async a=>{const f=await allowed(a.file);const text=await fs.readFile(f,'utf8');return {file:f,text,sha256:sha256(text)};},true);
tool('tia_write_source','Write SCL/XML in permitted roots. Overwriting requires matching previous SHA256 and creates a backup.',{file,text:z.string().max(2097152),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()},a=>createFile(a.file,a.text,a.expectedSha256));
tool('tia_generate_lad_latch','Generate a V18 LAD FC XML for Motor=(Start OR Motor) AND NOT Stop. Start/Stop are Bool inputs; Motor is Bool InOut. Import and compile before claiming validation.',{file,name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).default('MCP_LAD_Latch'),number:z.number().int().min(1).max(65535).default(101)},a=>createFile(a.file,latchLad(a.name,a.number)));
tool('tia_import_lad_xml','Back up and import TIA block XML. For replacement supply existing block name and its current canonical export hash. Supports LAD and other TIA XML block languages.',{cpu,file,replaceBlock:z.string().optional(),expectedBlockSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()},async a=>{
 const f=await allowed(a.file);const text=await fs.readFile(f,'utf8');if(!text.includes('<Document')||/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Expected TIA XML without DTD/entities');
 const blocks=await call('blocks',{cpu:a.cpu});
 // Only one top-level block per import: prevent an XML file replacing unrelated blocks.
 const names=[...text.matchAll(/<SW\.Blocks\.(?:OB|FB|FC|GlobalDB|InstanceDB)\b/g)];if(names.length!==1)throw Error('Import exactly one block XML at a time');
 const name=text.match(/<Name>([^<]+)<\/Name>/)?.[1];if(!name)throw Error('Missing block Name');
 if(blocks.some(b=>b.name===name)){
  if(a.replaceBlock!==name||!a.expectedBlockSha256)throw Error('Existing block requires replaceBlock and expectedBlockSha256');
  const temp=path.join(artifacts,`guard-${crypto.randomUUID()}.xml`);await call('export_block',{cpu:a.cpu,block:name,file:temp});
  if(sha256(canonicalXml(await fs.readFile(temp,'utf8')))!==a.expectedBlockSha256)throw Error('Block changed since last export');
 }else if(a.replaceBlock)throw Error('Replacement block not found');
 return call('import_xml',{cpu:a.cpu,file:f,replace:!!a.replaceBlock,replaceBlock:a.replaceBlock,expectedBlockSha256:a.expectedBlockSha256});
});
tool('tia_import_scl','Back up and generate NEW blocks from SCL. Existing block names are rejected; edit existing blocks through guarded XML import.',{cpu,file},async a=>{
 const f=await allowed(a.file);if(path.extname(f).toLowerCase()!=='.scl')throw Error('Expected .scl');
 const source=await fs.readFile(f,'utf8');
 const clean=source.replace(/\(\*[\s\S]*?\*\)/g,'').replace(/\/\/[^\r\n]*/g,'');
 const names=[...clean.matchAll(/^\s*(?:FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK|TYPE)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gmi)].map(m=>m[1]||m[2]);
 if(!names.length)throw Error('No block declarations found');
 const existing=await call('blocks',{cpu:a.cpu});if(names.some(n=>existing.some(b=>b.name===n)))throw Error('SCL would replace existing blocks. Use new names or guarded XML import.');
 if(/^\s*TYPE\b/mi.test(clean))throw Error('UDT import is not enabled in this version; avoiding unguarded type replacement.');
 return call('import_scl',{cpu:a.cpu,file:f});
});
tool('tia_list_tags','Read PLC tag tables, types and addresses recursively.',{cpu},a=>call('tags',a),true);
tool('tia_add_tag','Archive and create a new PLC tag. Existing names are never overwritten.',{cpu,table:z.string().min(1),name:z.string().min(1),type:z.string().min(1),address:z.string().min(1)},a=>call('add_tag',a));
tool('tia_compile','Compile hardware and software; return errors, warnings, nested messages and a saved report. Success requires zero errors. Does not hide warnings from the compiler.',{cpu},async a=>compileReport(await call('compile',a)));
tool('tia_compile_save','Back up, compile hardware and software, then save only when both compile without errors. Returns complete diagnostics and a saved report. Pre-existing unsaved user work still requires an explicit user save.',{cpu},async a=>compileReport(await call('compile_save',a)));
tool('tia_list_interfaces','Enumerate TIA download interfaces and their discovered addresses. Does not download or scan arbitrary IP ranges.',{cpu},a=>call('interfaces',a),true);
const ownedFile=path.join(artifacts,'managed-simulations.json');
const ownership=new ManagedSimulations(ownedFile);
const managed=name=>ownership.assert(name);
tool('tia_sim_list','List local PLCSIM Advanced instances. S7-1200 standard PLCSIM is a different backend.',{},()=>worker.call('sim_list'),true);
tool('tia_sim_create','Create a new owned PLCSIM Advanced S7-1500 instance. Defaults to local Softbus, independent of virtual-network configuration. Does not activate trials, adopt existing instances or change adapters.',{name:instance,cpuType:z.enum(['CPU1511','CPU1513','CPU1515','CPU1516','CPU1517','CPU1518']).default('CPU1511'),communication:z.enum(['Softbus','TCPIP']).default('Softbus')},async a=>{
 const storage=path.join(root,'projects','simulation',a.name);await allowed(storage);await fs.mkdir(storage,{recursive:true});
 if(a.communication==='TCPIP'&&!config.simulationNetwork)throw Error('TCPIP simulation requires the dedicated configured virtual network');
 const result=await worker.call('sim_create',{...a,storage});
 await ownership.add(a.name);return {...result,keepAlive:'Keep this MCP connection or the simulation control panel open while using the instance.'};
});
tool('tia_sim_control','Power on, run, stop, power off or inspect only an MCP-owned PLCSIM Advanced instance.',{name:instance,action:z.enum(['status','power_on','run','stop','power_off'])},async a=>{await managed(a.name);return worker.call('sim_control',a);});
tool('tia_sim_set_ip','Assign the configured private test IP to an owned simulated PLC only. Does not set physical PLC addresses.',{name:instance,interfaceId:z.number().int().min(0).max(64).default(0)},async a=>{await managed(a.name);const n=config.simulationNetwork;if(!n)throw Error('Simulation network is not configured');return worker.call('sim_set_ip',{...a,address:n.address,mask:n.mask});});
tool('tia_sim_remove','Unregister only an MCP-owned simulation that is already powered off. Storage files are preserved.',{name:instance},async a=>{await managed(a.name);const result=await worker.call('sim_remove',a);await ownership.remove(a.name);return result;});
tool('tia_sim_tags','Refresh and list simulated PLC tags.',{name:instance},async a=>{await managed(a.name);return worker.call('sim_tags',a);},true);
tool('tia_sim_read','Read a typed symbolic variable from an owned simulated PLC.',{name:instance,tag:z.string().min(1),type:z.enum(['Bool','Int','DInt','Real'])},async a=>{await managed(a.name);return worker.call('sim_value',{...a,write:false});},true);
tool('tia_sim_write','Write and read back a typed variable in an owned simulated PLC; never operates on a physical PLC.',{name:instance,tag:z.string().min(1),type:z.enum(['Bool','Int','DInt','Real']),value:z.union([z.boolean(),z.number().finite()])},async a=>{await managed(a.name);validateSimulationValue(a.type,a.value);return worker.call('sim_value',{...a,write:true});});
const typedSymbol={tag:z.string().min(1).max(1024),type:z.enum(['Bool','Int','DInt','Real'])};
const typedValue={...typedSymbol,value:z.union([z.boolean(),z.number().finite()])};
tool('tia_sim_batch','Read/write up to 100 owned simulation symbols in order. Validates ALL types and symbols before writes. Non-atomic; returns exact partial results and stops on runtime failure.',{name:instance,items:z.array(z.object({...typedSymbol,write:z.boolean().default(false),value:z.union([z.boolean(),z.number().finite()]).optional()})).min(1).max(simulationLimits.batchItems)},async a=>{await managed(a.name);const seen=new Set();for(const item of a.items){if(seen.has(canonicalTag(item.tag)))throw Error('Duplicate simulation symbol in batch: '+item.tag);seen.add(canonicalTag(item.tag));if(item.write)validateSimulationValue(item.type,item.value);}return worker.call('sim_values',a);});
const workflow=createSimulationWorkflow({invoke,assertOwned:managed,config});
tool('tia_sim_read_many','Read multiple typed symbols from the selected owned controller. Validates runtime symbols first; values are sequential readings, not a consistent PLC-cycle snapshot.',{name:instance,cpu,tags:z.array(z.object(typedSymbol)).min(1).max(simulationLimits.batchItems)},a=>workflow.readMany(a),true);
tool('tia_sim_write_many','Validate all typed values and runtime symbols before ordered writes to an owned controller. Returns readbacks and any partial failure; this is not an atomic PLC transaction.',{name:instance,cpu,values:z.array(z.object(typedValue)).min(1).max(simulationLimits.batchItems)},a=>workflow.writeMany(a));
tool('tia_sim_pulse','Press and release a Bool signal in an owned running simulation. Always attempts release, including after failure. Use activeValue:false/releaseValue:true for normally-closed stop inputs.',{name:instance,cpu,tag:typedSymbol.tag,durationMs:z.number().int().min(1).max(simulationLimits.pulseMs).default(200),activeValue:z.boolean().default(true),releaseValue:z.boolean().default(false)},a=>workflow.pulseBool(a));
tool('tia_sim_verify','Run bounded input/expected-value steps on an owned running simulation, then attempt all requested cleanup writes. Saves actual values, failed steps and cleanup results to a report.',{name:instance,cpu,steps:z.array(z.object({label:z.string().min(1).max(300).optional(),writes:z.array(z.object(typedValue)).max(simulationLimits.batchItems).optional(),waitMs:z.number().int().min(0).max(simulationLimits.stepWaitMs).default(200),expect:z.array(z.object({...typedValue,tolerance:z.number().finite().nonnegative().optional()})).min(1).max(simulationLimits.batchItems)})).min(1).max(simulationLimits.steps),cleanup:z.array(z.object(typedValue)).max(simulationLimits.batchItems).optional()},async a=>{const result=await workflow.verifyScenario(a);const reportFile=path.join(artifacts,'simulation-'+crypto.randomUUID()+'.json');await fs.writeFile(reportFile,JSON.stringify(result,null,2),{flag:'wx'});return {...result,reportFile};});
tool('tia_sim_open_motor_panel','Open or reuse a native start/stop/jog/overload panel for an existing owned RUN simulation. Opening only reads state; requires four Bool %I input tags, a Bool %Q motor output and a Bool latch.',motorPanelConfigSchema.shape,async a=>{
 await managed(a.name);const tables=await call('tags',{cpu:a.cpu});const tags=tables.flatMap(t=>t.tags);
 const inputAddresses=new Set();for(const role of ['start','stopOk','jog','overloadOk','motor']){const matches=tags.filter(t=>canonicalTag(t.name)===canonicalTag(a.tags[role]));const direction=role==='motor'?'Q':'I';if(matches.length!==1||matches[0].type!=='Bool'||!new RegExp('^%'+direction+'\\d+\\.[0-7]$','i').test(matches[0].address))throw Error('Panel role '+role+' requires exactly one Bool %'+direction+' bit in the selected offline PLC tag table');if(direction==='I'){const address=matches[0].address.toUpperCase().replace(/\d+/,n=>String(Number(n)));if(inputAddresses.has(address))throw Error('Motor panel input roles must use distinct input addresses');inputAddresses.add(address);}}
 return launchMotorPanel(a,{root,invoke});
});
const connection={cpu,mode:z.string().min(1),interface:z.string().min(1),interfaceNumber:z.number().int().positive().default(1),targetInterface:z.string().min(1),address:z.string().min(1)};
function simulationRoute(a){const virtual=config.simulationNetwork?.communication==='TCPIP'&&a.interface===config.simulationNetwork.adapter&&a.address===config.simulationNetwork.address;if((!virtual&&!/^PLCSIM(?:[. ]|$)/i.test(a.interface))||!/^(PN\/IE|MPI|S7ONLINE)$/i.test(a.mode))throw Error('Simulation download requires the configured Siemens virtual interface or local PLCSIM Softbus; physical interfaces are rejected.');}
tool('tia_sim_download','Compile, archive and download to local PLCSIM through an enumerated PLCSIM interface. Address must match the owned simulation controller.',{...connection,name:instance,startAfter:z.boolean().default(false)},async a=>{
 await managed(a.name);simulationRoute(a);const info=await worker.call('sim_control',{name:a.name,action:'status'});
 if(!((info.communication==='Softbus'&&/^PLCSIM(?:[. ]|$)/i.test(a.interface))||(info.communication==='TCPIP'&&a.interface===config.simulationNetwork?.adapter)))throw Error('Simulation communication does not match the configured isolated route');
 const network=await invoke('tia_cpu_network',{cpu:a.cpu});
 const others=[];const readStatus=async name=>{const status=await worker.call('sim_control',{name,action:'status'});others.push(status);return status;};
 const isolation=await assertSimulationDownloadTarget({name:a.name,cpu:network.cpu,address:a.address,status:info,offlineAddresses:network.nodes.map(n=>n.address),instances:await worker.call('sim_list'),assertOwned:managed,readStatus});
 const downloaded=await call('download',{...a,cpu:network.cpu});
 if(downloaded.success!==true)return {...downloaded,isolation};
 const after=await worker.call('sim_control',{name:a.name,action:'status'});
 const peerChanges=[];for(const before of others){const now=await worker.call('sim_control',{name:before.name,action:'status'});const identity=s=>JSON.stringify([s.state,s.controller,s.type,s.communication,[...s.addresses].sort()]);if(identity(before)!==identity(now))peerChanges.push({before,after:now});}
 const identityVerified=after.name===a.name&&after.controller===network.cpu&&!!after.type&&network.nodes.every(n=>after.addresses.includes(n.address));
 return {...downloaded,success:identityVerified&&peerChanges.length===0,isolation,after,identityVerified,otherInstancesUnchanged:peerChanges.length===0,...(peerChanges.length?{peerChanges}:{}),...(!identityVerified||peerChanges.length?{error:'Download completed, but post-download identity or peer-state verification failed; inspect the returned states before retrying.'}:{})};
});
tool('tia_sim_prepare_download','Compile and save, create a local Softbus simulation if explicitly requested, power on, select a real enumerated simulation route and download. Preserves existing channels and reports each completed stage on failure.',{name:instance,cpu:z.string().min(1),cpuType:z.enum(['CPU1511','CPU1513','CPU1515','CPU1516','CPU1517','CPU1518']).default('CPU1511'),communication:z.enum(['Softbus','TCPIP']).optional(),createIfMissing:z.boolean().default(false),startAfter:z.boolean().default(false),selection:z.object({mode:z.string().min(1).optional(),interface:z.string().min(1).optional(),interfaceNumber:z.number().int().positive().optional(),targetInterface:z.string().min(1).optional(),address:z.string().ip({version:'v4'}).optional()}).optional()},a=>workflow.prepareAndDownload(a));
tool('tia_physical_targets','List manually configured physical targets. Empty by default; no network scanning.',{},async()=>({targets:config.physicalTargets,hardwareValidated:false}),true);
tool('tia_physical_backend_check','Load the configured x64 Snap7 library, check entry points and create/destroy an unconnected client. Never contacts a PLC.',{},async()=>config.snap7Library?worker.call('physical_library',{library:config.snap7Library}):{installed:false,networkToPlcPerformed:false},true);
tool('tia_physical_prepare','Create a five-minute one-use physical action request. Must obtain user confirmation and local approval; never self-approve.',{targetId:z.string().min(1),action:z.enum(['download','connect','run','stop']),details:z.record(z.unknown())},a=>preparePhysical(a.targetId,a.action,a.details));
tool('tia_physical_inspect','Read CPU identity/status only from an explicitly configured target using optional Snap7. Refuses mismatched serial/model.',{targetId:z.string().min(1)},async a=>{const target=await assertPhysicalTarget(a.targetId);return physical('inspect',target);},true);
tool('tia_physical_control','Run/stop a configured physical CPU through optional Snap7, only after fresh identity verification and exact one-use user approval. Not hardware validated.',{approvalId:z.string().uuid(),action:z.enum(['run','stop']),targetId:z.string().min(1)},async a=>{const details={targetId:a.targetId};const target=await consumePhysical(a.approvalId,a.action,details);if(target.id!==a.targetId)throw Error('Target mismatch');return physical(a.action,target);});
tool('tia_physical_download','Download through TIA after compile, backup, target identity readback, and one-use user approval of exact connection and project contents. Not hardware validated.',{...connection,targetId:z.string().min(1),approvalId:z.string().uuid(),startAfter:z.boolean().default(false),projectFingerprint:z.string().regex(/^[a-f0-9]{64}$/)},async a=>{
 const {approvalId,...details}=a;const target=await consumePhysical(approvalId,'download',details);
 if(target.id!==a.targetId||a.address!==target.address)throw Error('Target/address mismatch');if(/PLCSIM/i.test(a.interface))throw Error('Expected physical interface');
 await physical('inspect',target);
 const fingerprint=await projectFingerprint(a.cpu);if(fingerprint!==a.projectFingerprint)throw Error('Project changed since approval');
 const project=await call('project');
 return call('download',{...a,physical:true,lastModified:project.lastModified});
});
tool('tia_physical_connect','Connect online to the exact configured CPU with identity verification and one-use approval; never changes protection or certificates.',{...connection,targetId:z.string().min(1),approvalId:z.string().uuid()},async a=>{
 const {approvalId,...details}=a;const target=await consumePhysical(approvalId,'connect',details);if(target.id!==a.targetId||a.address!==target.address)throw Error('Target/address mismatch');await physical('inspect',target);return call('online',{...a,action:'connect'});
});
async function projectFingerprint(cpuName){
 const project=await call('project');if(project.isModified)throw Error('Project has unsaved changes; compile, save and obtain a new fingerprint before physical approval');
 const blocks=await call('blocks',{cpu:cpuName});const values=[];
 for(const b of blocks){const f=path.join(artifacts,`fingerprint-${crypto.randomUUID()}.xml`);await call('export_block',{cpu:cpuName,block:b.name,file:f});values.push([b.name,sha256(canonicalXml(await fs.readFile(f,'utf8')))]);}
 const files=[];const dir=path.dirname(project.path);
 async function scan(folder){for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=await allowed(path.join(folder,entry.name));if(entry.isDirectory()){if(['Logs','TMP'].includes(entry.name))continue;await scan(f);}else if(entry.isFile()){files.push([path.relative(dir,f),sha256(await fs.readFile(f))]);}else throw Error('Unexpected project filesystem entry');}}
 await scan(dir);
 const after=await call('project');if(after.isModified||after.lastModified!==project.lastModified)throw Error('Project changed during fingerprint');
 return sha256(JSON.stringify({project,blocks:values.sort(),tags:await call('tags',{cpu:cpuName}),files}));
}
tool('tia_project_fingerprint','Compile hardware/software, back up and save, then hash project data files and exports for a physical download approval. Fails if project cannot be read consistently.',{cpu},async a=>{const compiled=await call('compile',a);if(!compiled.success)throw Error('Compile failed; no physical fingerprint issued');const saved=await call('save');return {sha256:await projectFingerprint(a.cpu),compiled,saved};});
async function physical(action,target){
 if(!config.snap7Library)throw Error('Optional Snap7 library is not installed/configured; physical operations are unavailable. See README.');
 return worker.call('physical',{action,...target,library:config.snap7Library});
}
process.on('SIGTERM',()=>{worker.close();process.exit(0);});
process.stdin.on('end',()=>worker.close());
await server.connect(new StdioServerTransport());
