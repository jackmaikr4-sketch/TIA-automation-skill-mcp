import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSimulationWorkflow,selectSimulationRoute,assertSimulationDownloadTarget,validateSimulationValue,validateScenario,simulationLimits} from '../src/simulation.mjs';

const name='CodexMCP_WorkflowTest',cpu='Test_CPU';
const privateNetwork={communication:'TCPIP',adapter:'Siemens PLCSIM Virtual Ethernet Adapter',address:'192.168.250.2',mask:'255.255.255.0'};
const interfaces=(adapter='PLCSIM',number=3,target='1 X1')=>[{mode:'PN/IE',interfaces:[{name:adapter,number,targets:[{name:target,addresses:[]}]}]}];
const loaded=(extra={})=>({name,state:'Run',communication:'Softbus',type:'CPU 1511-1 PN',controller:cpu,addresses:['192.168.250.2'],...extra});
function fixture({states=[loaded()],owners=states.map(s=>s.name),config={simulationNetwork:privateNetwork},route=interfaces(),values={},symbols,sleep=async()=>{},hook,batchHook}={}){
 const calls=[],owned=new Set(owners),instances=new Map(states.map(s=>[s.name,{...s}])),memory=new Map(Object.entries(values));
 const assertOwned=async n=>{calls.push({tool:'ownership',args:{name:n}});if(!owned.has(n))throw Error('This simulation was not created by this MCP');};
 const invoke=async(tool,args={})=>{
  calls.push({tool,args:structuredClone(args)});
  const special=await hook?.({tool,args,calls,instances,memory,owned});if(special?.handled)return special.value;
  if(tool==='tia_sim_list')return [...instances.values()].map((s,id)=>({id,name:s.name}));
  if(tool==='tia_compile_save')return {success:true,compiled:{hardware:{errors:0},software:{errors:0}},saved:true};
  if(tool==='tia_sim_create'){
   if(instances.has(args.name))throw Error('Instance already exists');
   const state={name:args.name,state:'Off',communication:args.communication,type:'',controller:'',addresses:[]};instances.set(args.name,state);owned.add(args.name);return {...state};
  }
  if(tool==='tia_sim_control'){
   const state=instances.get(args.name);if(!state)throw Error('DoesNotExist');
   if(args.action==='power_on'){state.state='Stop';state.addresses=['192.168.0.7'];}
   if(args.action==='run')state.state='Run';
   return structuredClone(state);
  }
  if(tool==='tia_list_interfaces')return route;
  if(tool==='tia_sim_download'){
   await assertSimulationDownloadTarget({name:args.name,cpu:args.cpu,address:args.address,status:instances.get(args.name),offlineAddresses:[privateNetwork.address],instances:[...instances.values()],assertOwned,readStatus:async n=>structuredClone(instances.get(n))});
   const state=instances.get(args.name);state.type='CPU 1511-1 PN';state.controller=args.cpu;if(args.startAfter)state.state='Run';
   return {success:true,errors:0,warnings:0};
  }
  if(tool==='tia_sim_batch'){
   for(let index=0;index<args.items.length;index++){
    const item=args.items[index];let error;
    if(symbols&&symbols[item.tag]!==item.type)error='Unknown symbol or type mismatch '+item.tag;
    else if(!item.write&&!memory.has(item.tag))error='Unknown symbol '+item.tag;
    if(error)return {instance:args.name,success:false,atomic:false,stage:'preflight',results:[],failedIndex:index,writesCompleted:0,completedCount:0,remainingNotExecuted:args.items.length,writeMayHaveApplied:false,error};
   }
   const results=[];let writesCompleted=0;
   for(let index=0;index<args.items.length;index++){
    const item=args.items[index];let writeCompleted=false;
    try{
     await batchHook?.({item,index,memory});
     if(item.write){memory.set(item.tag,item.type==='Real'?Math.fround(item.value):item.value);writeCompleted=true;writesCompleted++;}
     results.push({index,tag:item.tag,type:item.type,write:item.write,writeCompleted,value:memory.get(item.tag),success:true});
    }catch(error){results.push({index,tag:item.tag,type:item.type,write:item.write,writeCompleted,success:false,error:error.message,writeMayHaveApplied:item.write});return {instance:args.name,success:false,atomic:false,results,completedCount:index,writesCompleted,failedIndex:index,error:error.message,remainingNotExecuted:args.items.length-index-1};}
   }
   return {instance:args.name,success:true,atomic:false,results,completedCount:args.items.length,writesCompleted,failedIndex:null,remainingNotExecuted:0};
  }
  if(tool==='tia_sim_write'){memory.set(args.tag,args.type==='Real'?Math.fround(args.value):args.value);return {tag:args.tag,value:memory.get(args.tag),write:true};}
  if(tool==='tia_sim_read'){if(!memory.has(args.tag))throw Error('Unknown symbol '+args.tag);return {tag:args.tag,value:memory.get(args.tag),write:false};}
  throw Error('Unexpected tool '+tool);
 };
 return {calls,instances,memory,owned,workflow:createSimulationWorkflow({invoke,assertOwned,config,sleep})};
}
const write=(tag,value,type='Bool')=>({tag,type,value});
const expect=(tag,value,type='Bool')=>({tag,type,value});

test('new simulation defaults to Softbus, uses one live worker and powers on before enumerating/download',async()=>{
 const f=fixture({states:[]});
 const result=await f.workflow.prepareAndDownload({name,cpu,createIfMissing:true,startAfter:true});
 assert.equal(result.success,true);assert.equal(result.communication,'Softbus');assert.equal(result.after.state,'Run');
 const create=f.calls.find(c=>c.tool==='tia_sim_create');assert.equal(create.args.communication,'Softbus');
 const index=tool=>f.calls.findIndex(c=>c.tool===tool);
 assert.ok(index('tia_compile_save')<index('tia_sim_create'));
 assert.ok(f.calls.findIndex(c=>c.tool==='tia_sim_control'&&c.args.action==='power_on')<index('tia_list_interfaces'));
 assert.ok(index('tia_list_interfaces')<index('tia_sim_download'));
 const download=f.calls.find(c=>c.tool==='tia_sim_download').args;
 assert.deepEqual(download,{name,cpu,mode:'PN/IE',interface:'PLCSIM',interfaceNumber:3,targetInterface:'1 X1',address:'192.168.0.7',startAfter:true});
 assert.ok(!f.calls.some(c=>/remove|disconnect|physical|set_ip/.test(c.tool)));
});

test('failed compile-save prevents instance creation, power-on and download',async()=>{
 const f=fixture({states:[],hook:({tool})=>tool==='tia_compile_save'?{handled:true,value:{success:false,compiled:{software:{errors:2}}}}:null});
 await assert.rejects(f.workflow.prepareAndDownload({name,cpu,createIfMissing:true}),e=>e.code==='COMPILE_SAVE_FAILED'&&e.details.workflow.compileSave.compiled.software.errors===2);
 assert.ok(!f.calls.some(c=>['tia_sim_create','tia_sim_download'].includes(c.tool)));
});

test('existing instance ownership and CPU mismatch are checked before modifying project or runtime',async()=>{
 for(const options of [{owners:[]},{states:[loaded({controller:'Another_CPU'})]}]){
  const f=fixture(options);await assert.rejects(f.workflow.prepareAndDownload({name,cpu}));
  assert.ok(!f.calls.some(c=>['tia_compile_save','tia_sim_download','tia_sim_create'].includes(c.tool)));
  assert.ok(!f.calls.some(c=>c.tool==='tia_sim_control'&&c.args.action!=='status'));
 }
});

test('existing TCPIP channel is retained when omitted and never switched when explicitly different',async()=>{
 const f=fixture({states:[loaded({communication:'TCPIP'})],route:[...interfaces('Wi-Fi'),...interfaces(privateNetwork.adapter,8)]});
 const result=await f.workflow.prepareAndDownload({name,cpu});
 assert.equal(result.route.interface,privateNetwork.adapter);assert.equal(result.route.interfaceNumber,8);assert.equal(result.route.address,privateNetwork.address);
 assert.ok(!f.calls.some(c=>c.tool==='tia_sim_create'||c.args.action==='power_off'));
 const g=fixture({states:[loaded({communication:'TCPIP'})]});
 await assert.rejects(g.workflow.prepareAndDownload({name,cpu,communication:'Softbus'}),e=>e.code==='SIMULATION_CHANNEL_MISMATCH');
 assert.ok(!g.calls.some(c=>c.tool==='tia_compile_save'));
});

test('virtual-switch error suggests a new Softbus instance without mutating any adapters or existing channels',async()=>{
 const f=fixture({states:[],hook:({tool,args})=>{if(tool==='tia_sim_control'&&args.action==='power_on')throw Error('Error Code: -50, VirtualSwitchMisconfigured');}});
 await assert.rejects(f.workflow.prepareAndDownload({name,cpu,createIfMissing:true,communication:'TCPIP'}),e=>e.code==='VIRTUAL_SWITCH_CONFIGURATION'&&/Softbus/.test(e.recovery)&&e.details.workflow.created);
 assert.equal(f.calls.filter(c=>c.tool==='tia_sim_create').length,1);assert.ok(!f.calls.some(c=>c.tool==='tia_sim_download'||c.args.action==='power_off'));
});

test('workflow delegates collision checks to the download handler without stopping other simulations',async()=>{
 const other=loaded({name:'CodexMCP_Other',controller:'Other_CPU'});
 const f=fixture({states:[other]});
 await assert.rejects(f.workflow.prepareAndDownload({name,cpu,createIfMissing:true}),e=>e.code==='SIMULATION_ADDRESS_CONFLICT');
 assert.equal(f.instances.get(other.name).state,'Run');assert.equal(f.calls.filter(c=>c.tool==='tia_sim_download').length,1);assert.ok(!f.calls.some(c=>c.args.action==='power_off'));
});

test('missing runtime PLCSIM interface never falls back to a physical network adapter',async()=>{
 const f=fixture({route:interfaces('Realtek Ethernet')});
 await assert.rejects(f.workflow.prepareAndDownload({name,cpu}),e=>e.code==='SIMULATION_INTERFACE_UNAVAILABLE'&&/powered on/.test(e.recovery)&&e.details.workflow.stage==='interfaces');
 assert.ok(!f.calls.some(c=>c.tool==='tia_sim_download'));
});

test('route selection rejects multiple actual addresses unless one is explicitly selected',()=>{
 const status=loaded({addresses:['192.168.0.7','192.168.1.8']});
 assert.throws(()=>selectSimulationRoute({interfaces:interfaces(),status,cpu}),e=>e.code==='SIMULATION_ROUTE_AMBIGUOUS');
 const route=selectSimulationRoute({interfaces:interfaces(),status,cpu,selection:{address:'192.168.1.8'}});assert.equal(route.address,'192.168.1.8');
 assert.throws(()=>selectSimulationRoute({interfaces:interfaces(),status,cpu,selection:{address:'192.168.1.9'}}),e=>e.code==='SIMULATION_INTERFACE_UNAVAILABLE');
});

test('route selection uses simulator status, not cached unrelated TIA addresses, and enforces TCPIP private route',()=>{
 const source=interfaces();source[0].interfaces[0].targets[0].addresses=['10.99.99.99'];
 assert.equal(selectSimulationRoute({interfaces:source,status:loaded(),cpu}).address,'192.168.250.2');
 assert.throws(()=>selectSimulationRoute({interfaces:interfaces(privateNetwork.adapter),status:loaded({communication:'TCPIP',addresses:['10.2.3.4']}),cpu,config:{simulationNetwork:privateNetwork}}),e=>e.code==='SIMULATION_ADDRESS_MISMATCH');
 assert.throws(()=>selectSimulationRoute({interfaces:source,status:loaded({addresses:['0.0.0.0']}),cpu}),e=>e.code==='SIMULATION_ADDRESS_UNAVAILABLE');
});

test('every batch write is type-validated before any tool call, including the last item',async()=>{
 const invalid=[write('B',1),write('I',32768,'Int'),write('I',1.1,'Int'),write('D',2147483648,'DInt'),write('R',Infinity,'Real'),write('R',3.5e38,'Real')];
 for(const item of invalid){const f=fixture();await assert.rejects(f.workflow.writeMany({name,values:[write('A',true),item]}));assert.equal(f.calls.length,0);}
 for(const [type,value] of [['Int',-32768],['Int',32767],['DInt',-2147483648],['DInt',2147483647],['Real',3.4028234663852886e38],['Bool',false]])assert.equal(validateSimulationValue(type,value),value);
});

test('duplicate batch tags are rejected before writes, preserving the initial value',async()=>{
 const f=fixture({values:{A:false}});await assert.rejects(f.workflow.writeMany({name,values:[write('A',true),write('A',false)]}),/Duplicate tag/);
 assert.equal(f.memory.get('A'),false);assert.equal(f.calls.length,0);
});

test('partial write failure reports applied values and uncertainty without replaying or continuing',async()=>{
 const f=fixture({values:{A:false,B:false,C:false},batchHook:({item,memory})=>{if(item.tag==='B'){memory.set('B',item.value);throw Error('Readback disconnected after write');}}});
 const result=await f.workflow.writeMany({name,cpu,values:[write('A',true),write('B',true),write('C',true)]});
 assert.equal(result.success,false);assert.equal(result.atomic,false);assert.equal(result.failedIndex,1);assert.equal(result.skipped,1);
 assert.equal(result.values[0].status,'written');assert.equal(result.values[1].writeMayHaveOccurred,true);
 assert.equal(f.memory.get('A'),true);assert.equal(f.memory.get('B'),true);assert.equal(f.memory.get('C'),false);
 assert.equal(f.calls.filter(c=>c.tool==='tia_sim_batch').length,1);assert.equal(f.calls.filter(c=>c.tool==='tia_sim_write').length,0);
});

test('batch read preflight rejects missing symbols before collecting a partial snapshot',async()=>{
 const f=fixture({values:{A:true}});const result=await f.workflow.readMany({name,tags:[{tag:'A',type:'Bool'},{tag:'Missing',type:'Bool'}]});
 assert.equal(result.success,false);assert.equal(result.consistentSnapshot,false);assert.equal(result.failedTag,'Missing');assert.deepEqual(result.values,[]);assert.equal(result.batch.stage,'preflight');assert.equal(result.batch.completedCount,0);
});

test('batch runtime read failure preserves completed values without claiming a consistent snapshot',async()=>{
 const f=fixture({values:{A:true,B:false},batchHook:({item})=>{if(item.tag==='B')throw Error('Read connection lost');}});
 const result=await f.workflow.readMany({name,tags:[{tag:'A',type:'Bool'},{tag:'B',type:'Bool'}]});
 assert.equal(result.success,false);assert.equal(result.consistentSnapshot,false);assert.equal(result.failedTag,'B');assert.deepEqual(result.values,[{tag:'A',type:'Bool',value:true}]);assert.equal(result.batch.completedCount,1);
});

test('runtime symbol and type preflight occurs for the entire write batch before any value changes',async()=>{
 for(const bad of [write('Missing',true),write('I',true)]){
  const f=fixture({values:{A:false,I:0},symbols:{A:'Bool',I:'Int'}});
  const result=await f.workflow.writeMany({name,values:[write('A',true),bad]});
  assert.equal(result.success,false);assert.equal(result.batch.stage,'preflight');assert.equal(result.batch.writesCompleted,0);assert.equal(result.writeMayHaveOccurred,false);assert.equal(result.failedIndex,1);assert.equal(result.skipped,2);assert.equal(f.memory.get('A'),false);
  assert.deepEqual(f.calls.filter(c=>c.tool==='tia_sim_batch')[0].args,{name,items:[{tag:'A',type:'Bool',write:true,value:true},{tag:bad.tag,type:'Bool',write:true,value:true}]});
 }
});

test('batch transport failure remains uncertain and is never blindly replayed',async()=>{
 const f=fixture({hook:({tool})=>{if(tool==='tia_sim_batch')throw Error('Worker disconnected after submission');}});
 const result=await f.workflow.writeMany({name,values:[write('A',true)]});
 assert.equal(result.success,false);assert.equal(result.executionConfirmed,false);assert.equal(result.writeMayHaveOccurred,true);assert.equal(result.skipped,null);assert.equal(result.allReadbacksMatch,false);assert.equal(f.calls.filter(c=>c.tool==='tia_sim_batch').length,1);
});

test('incomplete or inconsistent success responses cannot report a successful write batch',async()=>{
 for(const response of [{instance:name,success:true,results:[]},{instance:name,success:true,results:[{index:0,tag:'A',type:'Bool',write:true,success:false,error:'Failed despite top-level success'}]},{isError:true,content:[]}]){
  const f=fixture({hook:({tool})=>tool==='tia_sim_batch'?{handled:true,value:response}:null});
  const result=await f.workflow.writeMany({name,values:[write('A',true)]});assert.equal(result.success,false);assert.equal(result.allReadbacksMatch,false);assert.ok(result.error);
 }
});

test('write readback mismatches fail explicitly instead of allowing a scenario to continue',async()=>{
 const f=fixture({values:{Motor:false},hook:({tool,args})=>tool==='tia_sim_batch'&&args.items[0].write?{handled:true,value:{instance:name,success:true,results:[{index:0,tag:'Start',type:'Bool',write:true,writeCompleted:true,value:false,success:true}],completedCount:1,writesCompleted:1,remainingNotExecuted:0}}:null});
 const result=await f.workflow.verifyScenario({name,steps:[{writes:[write('Start',true)],expect:[expect('Motor',false)]}],cleanup:[write('Start',false)]});
 assert.equal(result.success,false);assert.equal(result.error.code,'SIMULATION_WRITE_READBACK_MISMATCH');assert.equal(result.steps[0].expectations.length,0);assert.equal(result.cleanup.success,true);
});

test('Real write readback accepts IEEE single precision rounding rather than demanding a double',async()=>{
 const f=fixture();const result=await f.workflow.writeMany({name,values:[write('R',0.1,'Real')]});
 assert.equal(result.success,true);assert.equal(result.allReadbacksMatch,true);assert.equal(result.values[0].actual,Math.fround(0.1));
});

test('Bool pulse supports normally-closed inputs and always releases after a failed wait',async()=>{
 const f=fixture({values:{StopOK:true},sleep:async()=>{throw Error('Interrupted wait');}});
 const result=await f.workflow.pulseBool({name,cpu,tag:'StopOK',activeValue:false,releaseValue:true,durationMs:250});
 assert.equal(result.success,false);assert.equal(result.releaseConfirmed,true);assert.equal(f.memory.get('StopOK'),true);
 assert.deepEqual(f.calls.filter(c=>c.tool==='tia_sim_write').map(c=>c.args.value),[false,true]);
});

test('a failed activation still attempts release because a write may already have occurred',async()=>{
 const f=fixture({values:{Start:false},hook:({tool,args,memory})=>{if(tool==='tia_sim_write'&&args.value===true){memory.set(args.tag,true);throw Error('Read failed after activation');}}});
 const result=await f.workflow.pulseBool({name,tag:'Start'});assert.equal(result.success,false);assert.equal(result.releaseConfirmed,true);assert.equal(f.memory.get('Start'),false);
});

test('release failure is explicit and never reported as a successful pulse',async()=>{
 const f=fixture({hook:({tool,args})=>{if(tool==='tia_sim_write'&&args.value===false)throw Error('Connection lost during release');}});
 const result=await f.workflow.pulseBool({name,tag:'Start'});assert.equal(result.success,false);assert.equal(result.releaseConfirmed,false);assert.match(result.releaseError.message,/release/);
});

test('concurrent pulses are serialized through release, including after the first failure',async()=>{
 let waits=0;const f=fixture({sleep:async()=>{await new Promise(r=>setTimeout(r,3));if(++waits===1)throw Error('First pulse interrupted');}});
 const results=await Promise.all([f.workflow.pulseBool({name,tag:'A'}),f.workflow.pulseBool({name,tag:'B'})]);
 assert.deepEqual(f.calls.filter(c=>c.tool==='tia_sim_write').map(c=>[c.args.tag,c.args.value]),[['A',true],['A',false],['B',true],['B',false]]);
 assert.equal(results[0].success,false);assert.equal(results[1].success,true);
});

test('pulse bounds and stopped/incorrect controllers reject before changing inputs',async()=>{
 const f=fixture();await assert.rejects(f.workflow.pulseBool({name,tag:'Start',durationMs:simulationLimits.pulseMs+1}));assert.equal(f.calls.length,0);
 const g=fixture({states:[loaded({state:'Stop'})]});await assert.rejects(g.workflow.pulseBool({name,tag:'Start'}),e=>e.code==='SIMULATION_NOT_RUNNING');assert.ok(!g.calls.some(c=>c.tool==='tia_sim_write'));
});

test('scenario expectation failure keeps actual/expected evidence, skips later steps and executes cleanup',async()=>{
 const f=fixture({values:{Start:false,Motor:false}});
 const result=await f.workflow.verifyScenario({name,cpu,steps:[{label:'start motor',writes:[write('Start',true)],expect:[expect('Motor',true)]},{label:'must not run',writes:[write('Unreached',true)],expect:[expect('Motor',false)]}],cleanup:[write('Start',false)]});
 assert.equal(result.success,false);assert.deepEqual(result.failedStep,{index:0,label:'start motor'});assert.equal(result.skippedSteps,1);
 assert.deepEqual(result.steps[0].expectations[0],{tag:'Motor',type:'Bool',expected:true,actual:false,matched:false});
 assert.equal(result.cleanup.attempted,true);assert.equal(result.cleanup.success,true);assert.equal(f.memory.get('Start'),false);assert.equal(f.memory.has('Unreached'),false);
});

test('cleanup failure does not erase the original mismatch, and remaining cleanup writes are attempted',async()=>{
 const f=fixture({values:{Motor:false},hook:({tool,args})=>{if(tool==='tia_sim_write'&&args.tag==='BadCleanup')throw Error('Cleanup symbol missing');}});
 const result=await f.workflow.verifyScenario({name,steps:[{expect:[expect('Motor',true)]}],cleanup:[write('BadCleanup',false),write('Start',false)]});
 assert.equal(result.success,false);assert.equal(result.error.code,'SIMULATION_EXPECTATION_FAILED');assert.equal(result.cleanup.success,false);assert.equal(result.cleanup.values.length,2);assert.equal(f.memory.get('Start'),false);
});

test('scenario cleanup runs after successful verification and explicitly reports when none is supplied',async()=>{
 const f=fixture({values:{Motor:false}});
 const a=await f.workflow.verifyScenario({name,steps:[{writes:[write('Start',true)],expect:[expect('Motor',false)]}],cleanup:[write('Start',false)]});assert.equal(a.success,true);assert.equal(a.cleanup.success,true);assert.equal(f.memory.get('Start'),false);
 const b=await f.workflow.verifyScenario({name,steps:[{expect:[expect('Motor',false)]}]});assert.equal(b.success,true);assert.equal(b.cleanup.attempted,false);assert.match(b.cleanup.skippedReason,/No cleanup/);
});

test('a read error preserves earlier expectations and cleanup still releases the input',async()=>{
 const f=fixture({values:{A:true,Missing:true},batchHook:({item})=>{if(!item.write&&item.tag==='Missing')throw Error('Missing runtime read failed');}});
 const result=await f.workflow.verifyScenario({name,steps:[{writes:[write('Start',true)],expect:[expect('A',true),expect('Missing',true)]}],cleanup:[write('Start',false)]});
 assert.equal(result.success,false);assert.equal(result.steps[0].expectations.length,1);assert.match(result.error.message,/Missing/);assert.equal(result.cleanup.success,true);assert.equal(f.memory.get('Start'),false);
});

test('unverified ownership never triggers scenario cleanup writes',async()=>{
 const f=fixture({owners:[]});const result=await f.workflow.verifyScenario({name,steps:[{expect:[expect('Motor',false)]}],cleanup:[write('Start',false)]});
 assert.equal(result.success,false);assert.equal(result.cleanup.attempted,false);assert.match(result.cleanup.skippedReason,/not verified/);assert.ok(!f.calls.some(c=>c.tool==='tia_sim_write'));
});

test('controller changes during a scenario prevent further writes and cleanup to the wrong target',async()=>{
 let statuses=0;const f=fixture({values:{Motor:false},hook:({tool,args,instances})=>{if(tool==='tia_sim_control'&&args.action==='status'&&++statuses===3)instances.get(name).controller='Replacement_CPU';}});
 const result=await f.workflow.verifyScenario({name,cpu,steps:[{expect:[expect('Motor',false)]},{writes:[write('MustNotWrite',true)],expect:[expect('Motor',false)]}],cleanup:[write('Start',false)]});
 assert.equal(result.success,false);assert.equal(result.error.code,'SIMULATION_CPU_MISMATCH');assert.equal(result.cleanup.attempted,false);assert.equal(f.memory.has('MustNotWrite'),false);assert.equal(f.memory.has('Start'),false);
});

test('scenario bounds, duplicates and cleanup values are validated before any simulation call',async()=>{
 const step={expect:[expect('Motor',false)],waitMs:0};
 const invalid=[
  {steps:Array.from({length:101},()=>step)},
  {steps:[{...step,writes:[write('A',true),write('A',false)]}]},
  {steps:[{expect:[expect('A',true),expect('A',false)]}]},
  {steps:Array.from({length:7},()=>({...step,waitMs:10000}))},
  {steps:[step],cleanup:[write('IntCleanup',40000,'Int')]},
  {steps:[{expect:[{...expect('Motor',false),tolerance:0.1}]}]},
  {steps:Array.from({length:11},()=>({waitMs:0,expect:Array.from({length:100},(_,i)=>expect('T'+i,true))}))}
 ];
 for(const args of invalid){const f=fixture();await assert.rejects(f.workflow.verifyScenario({name,...args}));assert.equal(f.calls.length,0);}
 assert.equal(validateScenario({steps:[{writes:[write('A',true)],expect:[expect('A',true)]}]}).totalItems,2);
});

test('Real scenario expectations use float readback or an explicit tolerance',async()=>{
 const f=fixture({values:{R:Math.fround(0.1)}});
 const result=await f.workflow.verifyScenario({name,steps:[{expect:[expect('R',0.1,'Real')]},{expect:[{...expect('R',0.1001,'Real'),tolerance:0.001}]}]});assert.equal(result.success,true);
});

function downloadGuard({status=loaded(),offlineAddresses=['192.168.250.2'],others=[],owners,readError,address=status.addresses[0],cpuName=cpu}={}){
 const states=[status,...others],known=new Set(owners??states.map(item=>item.name)),reads=[],ownershipChecks=[];
 const promise=assertSimulationDownloadTarget({name,cpu:cpuName,address,status,offlineAddresses,instances:states.map(item=>({name:item.name})),assertOwned:async n=>{ownershipChecks.push(n);if(!known.has(n))throw Error('Unknown owner');},readStatus:async n=>{reads.push(n);if(readError)throw Error(readError);return structuredClone(states.find(item=>item.name===n));}});
 return {promise,reads,ownershipChecks};
}

test('download guard allows owned powered simulations with distinct controller and current/final IP addresses',async()=>{
 const other=loaded({name:'CodexMCP_Other',controller:'Other_CPU',addresses:['192.168.250.3']});
 const f=downloadGuard({status:loaded({type:'',controller:'',addresses:['192.168.0.7']}),others:[other]});
 const result=await f.promise;assert.equal(result.isolated,true);assert.deepEqual(result.targetAddresses,['192.168.0.7']);assert.deepEqual(result.offlineAddresses,['192.168.250.2']);assert.equal(result.checkedOtherInstances[0].controller,'Other_CPU');assert.deepEqual(f.reads,[other.name]);
});

test('download guard rejects current duplicate IP and final offline IP collision separately',async()=>{
 for(const [otherAddress,expectedConflict] of [['192.168.0.7','192.168.0.7'],['192.168.250.2','192.168.250.2']]){
  const other=loaded({name:'CodexMCP_Other',controller:'Other_CPU',addresses:[otherAddress]});
  await assert.rejects(downloadGuard({status:loaded({addresses:['192.168.0.7']}),others:[other]}).promise,e=>e.code==='SIMULATION_ADDRESS_CONFLICT'&&e.details.conflicts[0]===expectedConflict);
 }
});

test('download guard rejects duplicate controller identities even with different IP addresses',async()=>{
 const other=loaded({name:'CodexMCP_Other',controller:cpu,addresses:['192.168.250.3']});
 await assert.rejects(downloadGuard({others:[other]}).promise,e=>e.code==='SIMULATION_CONTROLLER_CONFLICT');
});

test('download guard rejects unknown ownership and unreadable registered instances',async()=>{
 const other=loaded({name:'CodexMCP_Other',controller:'Other_CPU',addresses:['192.168.250.3']});
 const unowned=downloadGuard({others:[other],owners:[name]});
 await assert.rejects(unowned.promise,e=>e.code==='SIMULATION_INSTANCE_NOT_OWNED');assert.deepEqual(unowned.reads,[]);
 await assert.rejects(downloadGuard({others:[{...other,name:'UserSimulator'}]}).promise,e=>e.code==='SIMULATION_INSTANCE_NOT_OWNED');
 await assert.rejects(downloadGuard({others:[other],readError:'Runtime unavailable'}).promise,e=>e.code==='SIMULATION_INSTANCE_UNINSPECTABLE'&&e.details.cause.message==='Runtime unavailable');
});

test('owned powered-off instances are inspected but do not block due to stale identities or addresses',async()=>{
 const other=loaded({name:'CodexMCP_Off',state:'Off',controller:cpu,addresses:[],communication:'TCPIP'});
 const f=downloadGuard({others:[other]});const result=await f.promise;assert.equal(result.isolated,true);assert.equal(result.checkedOtherInstances[0].conflictCheckSkipped,true);assert.deepEqual(f.reads,[other.name]);
 await assert.rejects(downloadGuard({others:[other],owners:[name]}).promise,e=>e.code==='SIMULATION_INSTANCE_NOT_OWNED');
});

test('download guard rejects unknown addresses and mixed channels on powered instances',async()=>{
 const other=loaded({name:'CodexMCP_Other',controller:'Other_CPU',addresses:['192.168.250.3']});
 for(const offlineAddresses of [[],['0.0.0.0'],['192.168.250.2','unknown']])await assert.rejects(downloadGuard({offlineAddresses}).promise,e=>e.code==='SIMULATION_ADDRESSES_UNKNOWN');
 await assert.rejects(downloadGuard({others:[{...other,addresses:[]}]}).promise,e=>e.code==='SIMULATION_ADDRESSES_UNKNOWN');
 await assert.rejects(downloadGuard({others:[{...other,communication:'TCPIP'}]}).promise,e=>e.code==='SIMULATION_CHANNEL_AMBIGUOUS');
});

test('download guard checks selected instance power, controller and actual route address',async()=>{
 await assert.rejects(downloadGuard({status:loaded({state:'Off'})}).promise,e=>e.code==='SIMULATION_POWERED_OFF');
 await assert.rejects(downloadGuard({status:loaded({controller:'Wrong_CPU'})}).promise,e=>e.code==='SIMULATION_CPU_MISMATCH');
 await assert.rejects(downloadGuard({address:'192.168.250.99'}).promise,e=>e.code==='SIMULATION_ADDRESS_MISMATCH');
});
