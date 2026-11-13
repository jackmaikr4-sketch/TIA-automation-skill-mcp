import fs from 'node:fs/promises';
import path from 'node:path';
import {allowed,config} from './runtime.mjs';

const key=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
export class ProjectAccess {
 constructor(roots=config.allowedRoots){this.roots=roots;this.grants=new Set();}
 clear(){this.grants.clear();}
 async inspect(file){
  if(!file)return {allowed:false,scope:'none',reason:'No project is open'};
  try{await allowed(file,this.roots);return {allowed:true,scope:'configured_root'};}catch(e){
   if(e.message!=='Path outside configured project roots')throw e;
  }
  if(this.grants.has(key(file))){
   await allowed(file,[path.dirname(path.resolve(file))]);
   return {allowed:true,scope:'attached_project_session'};
  }
  return {allowed:false,scope:'none',reason:'This open project needs an exact-path session grant',nextTool:'tia_authorize_attached_project'};
 }
 async assert(file){
  const access=await this.inspect(file);
  if(!access.allowed)throw Object.assign(Error('Open project is outside configured roots. Use tia_authorize_attached_project with its exact .ap18 path, only for the project the user requested.'),{code:'PROJECT_SCOPE_REQUIRED',recovery:{action:'authorize_exact_attached_project',file,tool:'tia_authorize_attached_project'},retryable:false});
  return access;
 }
 async grant(file,connectedFile){
  if(typeof file!=='string'||!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.ap18')throw Error('Expected the absolute path of the attached .ap18 project');
  if(!connectedFile||key(file)!==key(connectedFile))throw Object.assign(Error('Requested project path does not match the currently attached project; no access was granted'),{code:'PROJECT_IDENTITY_MISMATCH'});
  await allowed(file,[path.dirname(path.resolve(file))]);
  if(!(await fs.stat(file)).isFile())throw Error('Attached project file does not exist');
  this.grants.add(key(file));
  return {project:path.resolve(file),scope:'attached_project_session',persistentConfigurationChanged:false,sourceFileRootsUnchanged:true};
 }
}

export function classifyToolError(error){
 let code=error.code||'TIA_OPERATION_FAILED';let recovery=error.recovery;let retryable=error.retryable===true;
 const message=error.message||String(error);
 if(message.includes('MCP_BUSY_BEFORE_EXECUTION')||message.includes('Another MCP instance is running')){
  code='TIA_BUSY';retryable=true;recovery={action:'wait_then_retry',message:'Another local TIA operation is in progress. This call did not execute.'};
 }else if(/timed out|Worker exited|stopped unexpectedly/.test(message)){
  code='OPERATION_OUTCOME_UNKNOWN';retryable=false;recovery={action:'inspect_before_retry',message:'Inspect the project and simulation state before retrying any write; its outcome is not known.'};
 }else if(/VirtualSwitchMisconfigured/.test(message)){
  code='SIM_VIRTUAL_SWITCH_CONFIGURATION';recovery={action:'use_softbus_for_new_instance',message:'For local simulation, create a new owned instance with communication: Softbus. Do not change physical network adapters.'};
 }else if(/pre-existing unsaved/.test(message)){
  code='UNSAVED_USER_CHANGES';recovery={action:'save_current_user_changes',message:'Save the current user changes in TIA first. No implicit save or overwrite was performed.'};
 }else if(/Inconsistent blocks and PLC data types/.test(message)){
  code='BLOCK_INCONSISTENT';recovery={action:'repair_compile_dependencies',message:'TIA cannot export an inconsistent block. Resolve its missing symbols/types using compiler diagnostics and compile again, or recover the saved project/backup. Guarded replacement is not bypassed.'};
 }else if(/^(PROJECT_IDENTITY_REQUIRED|PROJECT_IDENTITY_MISMATCH|NO_PLC_IN_PROJECT|CPU_REQUIRED|CPU_NOT_FOUND|CPU_AMBIGUOUS):/.test(message)){
  code=message.split(':',1)[0];recovery={action:'inspect_attached_project',tool:'tia_project_info',message:'Read the current project and CPU identity before starting a new operation.'};
 }
 return {error:message,code,type:error.workerType,details:error.details,recovery,retryable,verified:false};
}
