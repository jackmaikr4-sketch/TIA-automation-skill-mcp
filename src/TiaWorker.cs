using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Security;
using System.Web.Script.Serialization;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.Connection;
using Siemens.Engineering.Download;
using Siemens.Engineering.Download.Configurations;
using Siemens.Engineering.Online;
using Siemens.Engineering.Online.Configurations;
using Sim = Siemens.Simatic.Simulation.Runtime;

class Bootstrap {
 static int Main() {
  AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender,ResolveEventArgs a) {
   string n=new AssemblyName(a.Name).Name+".dll";
   foreach(string root in new[]{Environment.GetEnvironmentVariable("TIA_API_DIR"),Environment.GetEnvironmentVariable("TIA_SIM_API_DIR")}) {
    if(root!=null && File.Exists(Path.Combine(root,n))) return Assembly.LoadFrom(Path.Combine(root,n));
   }
   return null;
  };
  return Run();
 }
 [MethodImpl(MethodImplOptions.NoInlining)] static int Run(){return Worker.Run();}
}

class Worker {
 static JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=16777216,RecursionLimit=80};
 static TiaPortal portal;
 static Project project;
 static bool owned;
 static string backupRoot;
 static string lastArchive;
 static string checkpointProject;
 static string projectIdentity;
 static string activeProjectPath;
 static bool createdProject;
 static Dictionary<string,Sim.IInstance> simulationHandles=new Dictionary<string,Sim.IInstance>();
 static Dictionary<string,object> D(params object[] a){var d=new Dictionary<string,object>();for(int i=0;i<a.Length;i+=2)d[(string)a[i]]=a[i+1];return d;}
 static string S(Dictionary<string,object>a,string k,string fallback=""){return a.ContainsKey(k)?Convert.ToString(a[k]):fallback;}
 static int N(Dictionary<string,object>a,string k,int fallback=0){return a.ContainsKey(k)?Convert.ToInt32(a[k]):fallback;}
 static bool B(Dictionary<string,object>a,string k){return a.ContainsKey(k)&&Convert.ToBoolean(a[k]);}
 static void Need(){if(portal==null)throw new InvalidOperationException("Connect to a TIA instance first.");}
 static void NeedProject(){Need();RefreshProject();if(project==null)throw new InvalidOperationException("No project is open in this TIA session. Open or create a project first.");if(activeProjectPath!=null)CheckProjectIdentity(activeProjectPath);}
 public static int Run(){
  Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
  string line;
  while((line=Console.ReadLine())!=null){object id=null;try{
   var req=json.Deserialize<Dictionary<string,object>>(line);id=req["id"];
   var a=(Dictionary<string,object>)req["args"];
   object value;
   using(var mutex=new Mutex(false,"Local\\CodexTiaV18McpOperation")){
    bool entered=false;try{try{entered=mutex.WaitOne(0);}catch(AbandonedMutexException){entered=true;}
     if(!entered)throw new InvalidOperationException("MCP_BUSY_BEFORE_EXECUTION: Another MCP instance is running a TIA operation. This request was not executed; wait before retrying.");
     activeProjectPath=null;value=Execute((string)req["op"],a);
    }finally{activeProjectPath=null;if(entered)mutex.ReleaseMutex();}
   }
   Console.WriteLine(json.Serialize(D("id",id,"ok",true,"value",value)));
  }catch(Exception e){var details=e.ToString();while(e.InnerException!=null)e=e.InnerException;if(e is NonRecoverableException){portal=null;owned=false;SetProject(null,false);}Console.WriteLine(json.Serialize(D("id",id,"ok",false,"error",e.Message,"details",details,"type",e.GetType().FullName,"verified",false)));}}
  // Disposing an attached portal releases the API connection; it must not close a user's project.
  // Keep owned GUI sessions open too, so unsaved work remains recoverable after MCP disconnect.
  Environment.Exit(0);return 0;
 }
 static object Execute(string op,Dictionary<string,object>a){
  if(op=="diagnose"){if(portal!=null)RefreshProject();return D("apiVersion",typeof(TiaPortal).Assembly.GetName().Version.ToString(),"user",WindowsIdentity.GetCurrent().Name,"opennessTokenMember",new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole("Siemens TIA Openness"),"x64",Environment.Is64BitProcess,"connected",portal!=null,"owned",owned,"project",project==null?null:project.Path.FullName);}
  if(op=="physical")return Physical(a);
  if(op=="physical_library")return PhysicalLibrary(S(a,"library"));
  if(op=="processes")return TiaPortal.GetProcesses().Select(p=>D("id",p.Id,"projectPath",p.ProjectPath==null?null:p.ProjectPath.FullName)).ToArray();
  if(op=="connect"){
   if(portal!=null){
    int connectedPid=portal.GetCurrentProcess().Id;
    if(N(a,"pid")!=connectedPid)throw new InvalidOperationException("Already connected to TIA pid "+connectedPid+". Disconnect explicitly before changing sessions; no project was closed.");
    RefreshProject();return D("pid",connectedPid,"owned",owned,"project",project==null?null:project.Path.FullName,"alreadyConnected",true);
   }
   if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole("Siemens TIA Openness"))throw new UnauthorizedAccessException("Current Windows token is not a member of Siemens TIA Openness. Run scripts/enable-openness.ps1 from administrator PowerShell, then save work and sign out/in manually. No project was opened.");
   if(N(a,"pid")>0){var process=TiaPortal.GetProcesses().SingleOrDefault(p=>p.Id==N(a,"pid"));if(process==null)throw new ArgumentException("TIA process not found. List available instances and select its exact pid.");portal=process.Attach();owned=false;}
   else{portal=new TiaPortal(TiaPortalMode.WithUserInterface);owned=true;}
   SetProject(null,false);RefreshProject();
   backupRoot=S(a,"backupRoot");
   return D("pid",portal.GetCurrentProcess().Id,"owned",owned,"project",project==null?null:project.Path.FullName,"alreadyConnected",false);
  }
  if(op=="disconnect"){
   if(portal==null)return D("disconnected",true,"alreadyDisconnected",true,"projectClosed",false,"windowClosed",false);
   RefreshProject();int processId=portal.GetCurrentProcess().Id;string projectPath=project==null?null:project.Path.FullName;bool unsaved=project!=null&&project.IsModified;bool wasOwned=owned;
   portal.Dispose();portal=null;owned=false;SetProject(null,false);backupRoot=null;
   return D("disconnected",true,"alreadyDisconnected",false,"pid",processId,"project",projectPath,"hadUnsavedChanges",unsaved,"wasOwned",wasOwned,"projectClosed",false,"windowClosed",false);
  }
  if(op=="sim_list")return Sim.SimulationRuntimeManager.RegisteredInstanceInfo.Select(i=>D("id",i.ID,"name",i.Name)).ToArray();
  if(op=="sim_create"){
   string name=S(a,"name");
   if(Sim.SimulationRuntimeManager.RegisteredInstanceInfo.Any(i=>i.Name==name))throw new InvalidOperationException("Instance already exists; refusing to take ownership.");
   var inst=Sim.SimulationRuntimeManager.RegisterInstance((Sim.ECPUType)Enum.Parse(typeof(Sim.ECPUType),S(a,"cpuType","CPU1511")),name);
   simulationHandles[name]=inst;
   try{inst.StoragePath=S(a,"storage");inst.CommunicationInterface=(Sim.ECommunicationInterface)Enum.Parse(typeof(Sim.ECommunicationInterface),S(a,"communication","Softbus"));}
   catch{inst.UnregisterInstance();simulationHandles.Remove(name);throw;}
   return D("name",inst.Name,"state",inst.OperatingState.ToString(),"communication",inst.CommunicationInterface.ToString(),"license",inst.LicenseStatus.ToString());
  }
  if(op=="sim_control"){
   var inst=SimInstance(S(a,"name"));string act=S(a,"action");
   if(act=="power_on"){var status=inst.PowerOn(60000);if((int)status!=0)throw new InvalidOperationException("PowerOn status: "+status+". No trial is automatically activated.");}
   else if(act=="run")inst.Run(30000);else if(act=="stop")inst.Stop(30000);else if(act=="power_off")inst.PowerOff(30000);
   else if(act!="status")throw new ArgumentException("Unknown simulation action");
   return D("name",inst.Name,"state",inst.OperatingState.ToString(),"license",inst.LicenseStatus.ToString(),"controller",inst.ControllerName,"type",inst.ControllerShortDesignation,"addresses",inst.ControllerIP,"communication",inst.CommunicationInterface.ToString());
  }
  if(op=="sim_tags"){
   var inst=SimInstance(S(a,"name"));inst.UpdateTagList();
   return inst.TagInfos.Select(t=>D("name",t.Name,"type",t.DataType.ToString())).ToArray();
  }
  if(op=="sim_set_ip"){
   var inst=SimInstance(S(a,"name"));inst.SetIPSuite((uint)N(a,"interfaceId",1),new Sim.SIPSuite4(S(a,"address"),S(a,"mask"),"0.0.0.0"),true);
   return D("name",inst.Name,"addresses",inst.ControllerIP,"interfaceId",N(a,"interfaceId",1));
  }
  if(op=="sim_remove"){
   var inst=SimInstance(S(a,"name"));if(inst.OperatingState!=Sim.EOperatingState.Off)throw new InvalidOperationException("Power off before unregistering an MCP simulation");
   inst.UnregisterInstance();simulationHandles.Remove(S(a,"name"));return D("removed",true,"storagePreserved",true);
  }
  if(op=="sim_value"){
   ValidateSimValue(a);var inst=SimInstance(S(a,"name"));
   if(B(a,"write"))WriteSimValue(inst,a);
   return D("instance",inst.Name,"tag",S(a,"tag"),"value",ReadSimValue(inst,a),"write",B(a,"write"));
  }
  if(op=="sim_values"){
   var raw=a.ContainsKey("items")?a["items"] as IEnumerable:null;
   if(raw==null||a["items"] is string)throw new ArgumentException("items must be a nonempty array of typed variables");
   var items=new List<Dictionary<string,object>>();
   foreach(object item in raw){var value=item as Dictionary<string,object>;if(value==null)throw new ArgumentException("Each item must contain tag, type and optional write/value");ValidateSimValue(value);items.Add(value);}
   if(items.Count<1||items.Count>128)throw new ArgumentException("Batch must contain between 1 and 128 variables");
   var inst=SimInstance(S(a,"name"));
   // Validate every typed symbol with the runtime before the first write. This is
   // not a PLC transaction: scans can run between items and writes are sequential.
   inst.UpdateTagList();
   for(int i=0;i<items.Count;i++)try{
    string tag=S(items[i],"tag"),type=S(items[i],"type");
    var matches=inst.TagInfos.Where(t=>t.Name==tag||t.Name.Replace("\"","")==tag.Replace("\"","")).ToArray();
    if(matches.Length!=1)throw new ArgumentException("Symbol not found or ambiguous: "+tag);
    if(matches[0].DataType.ToString()!=type)throw new ArgumentException("Symbol type mismatch for "+tag+": expected "+matches[0].DataType+", received "+type);
    ReadSimValue(inst,items[i]);
   }catch(Exception e){return D("instance",inst.Name,"success",false,"atomic",false,"stage","preflight","results",new object[0],"failedIndex",i,"writesCompleted",0,"completedCount",0,"remainingNotExecuted",items.Count,"writeMayHaveApplied",false,"error","Batch preflight failed at item "+i+" ("+S(items[i],"tag")+"); no batch writes were performed. "+e.Message);}
   var results=new List<object>();int writesCompleted=0;
   for(int i=0;i<items.Count;i++){
    var item=items[i];bool writeCompleted=false;
    try{
     if(B(item,"write")){WriteSimValue(inst,item);writeCompleted=true;writesCompleted++;}
     results.Add(D("index",i,"tag",S(item,"tag"),"type",S(item,"type"),"write",B(item,"write"),"writeCompleted",writeCompleted,"value",ReadSimValue(inst,item),"success",true));
    }catch(Exception e){
     results.Add(D("index",i,"tag",S(item,"tag"),"type",S(item,"type"),"write",B(item,"write"),"writeCompleted",writeCompleted,"success",false,"error",e.Message,"writeMayHaveApplied",B(item,"write")));
     return D("instance",inst.Name,"success",false,"atomic",false,"results",results,"completedCount",i,"writesCompleted",writesCompleted,"failedIndex",i,"error",e.Message,"remainingNotExecuted",items.Count-i-1);
    }
   }
   return D("instance",inst.Name,"success",true,"atomic",false,"results",results,"completedCount",items.Count,"writesCompleted",writesCompleted,"failedIndex",null,"remainingNotExecuted",0);
  }
  Need();RefreshProject();
  if(op=="end_session"){
   if(!owned||project!=null)throw new InvalidOperationException("Only an owned session with no open project may be ended");
   int processId=portal.GetCurrentProcess().Id;portal.Dispose();portal=null;owned=false;SetProject(null,false);
   bool closeRequested=false;try{closeRequested=System.Diagnostics.Process.GetProcessById(processId).CloseMainWindow();}catch(ArgumentException){}
   return D("ended",true,"windowCloseRequested",closeRequested);
  }
  if(op=="open"){
   if(project!=null)throw new InvalidOperationException("A project is already open. Refusing to close it implicitly.");
   SetProject(portal.Projects.Open(new FileInfo(S(a,"file"))),false);return D("name",project.Name,"path",project.Path.FullName);
  }
  if(op=="create"){
   if(project!=null)throw new InvalidOperationException("A project is already open.");
   SetProject(portal.Projects.Create(new DirectoryInfo(S(a,"directory")),S(a,"name")),true);project.Save();return D("name",project.Name,"path",project.Path.FullName);
  }
  NeedProject();
  if(op!="project"){
   string expected=S(a,"expectedProjectPath");
   if(String.IsNullOrWhiteSpace(expected)||!Regex.IsMatch(expected,@"^(?:[A-Za-z]:[\\/]|\\\\)"))throw new InvalidOperationException("PROJECT_IDENTITY_REQUIRED: Read the current project and supply its exact absolute expectedProjectPath before this operation.");
   activeProjectPath=Path.GetFullPath(expected);CheckProjectIdentity(activeProjectPath);
  }
  if(op=="close_project"){
   if(!owned)throw new InvalidOperationException("Refusing to close a user-attached project.");
   if(project.IsModified)throw new InvalidOperationException("Project contains unsaved changes; save explicitly before closing.");
   project.Close();SetProject(null,false);return D("closed",true);
  }
  if(op=="enable_simulation"){string b=Backup();project.IsSimulationDuringBlockCompilationEnabled=true;return D("enabled",project.IsSimulationDuringBlockCompilationEnabled,"backup",b);}
  if(op=="project")return D("name",project.Name,"path",project.Path.FullName,"isModified",project.IsModified,"lastModified",project.LastModified.ToUniversalTime().ToString("O"),"devices",project.Devices.Select(d=>D("name",d.Name,"items",Items(d.DeviceItems).Select(i=>D("name",i.Name,"typeIdentifier",Attr(i,"TypeIdentifier"),"plc",GetPlc(i)!=null)).ToArray())).ToArray());
  if(op=="backup")return Backup();
  if(op=="save"){string b=Backup();project.Save();return D("saved",true,"path",project.Path.FullName,"backup",b);}
  if(op=="add_device"){
   string b=Backup();using(var access=portal.ExclusiveAccess("MCP add device")){
    var d=project.Devices.CreateWithItem(S(a,"typeIdentifier"),S(a,"itemName"),S(a,"name"));return D("device",d.Name,"backup",b);
   }
  }
  var cpu=FindCpu(S(a,"cpu"));var plc=GetPlc(cpu);
  if(op=="cpu_network"){
   var nodes=new List<object>();
   foreach(var item in Items(cpu.DeviceItems)){var net=item.GetService<NetworkInterface>();if(net==null)continue;foreach(var node in net.Nodes)nodes.Add(D("interface",item.Name,"name",node.Name,"address",node.GetAttribute("Address"),"mask",node.GetAttribute("SubnetMask"),"subnet",node.ConnectedSubnet==null?null:node.ConnectedSubnet.Name));}
   return D("cpu",cpu.Name,"nodes",nodes);
  }
  if(op=="prepare_new_plc_simulation"){
   if(!createdProject)throw new InvalidOperationException("This preparation is limited to a new project created by this MCP session; existing project security is not changed");
   if(project.Devices.SelectMany(d=>Items(d.DeviceItems)).Count(i=>GetPlc(i)!=null)!=1)throw new InvalidOperationException("Automatic simulation preparation currently supports one PLC per project");
   var args=new Dictionary<string,object>(a);args["freshSimulation"]=true;
   var security=Execute("initialize_test_security",args);project.IsSimulationDuringBlockCompilationEnabled=true;
   return D("security",security,"network",Execute("test_network",args),"simulationEnabled",true);
  }
  if(op=="test_network"){
   if(!B(a,"freshSimulation")||!createdProject)RequireTestProject();string backup=Backup();var nodes=new List<object>();
   var subnet=project.Subnets.FirstOrDefault(s=>s.Name=="CodexMCP_Simulation")??project.Subnets.Create("System:Subnet.Ethernet","CodexMCP_Simulation");
   foreach(var item in Items(cpu.DeviceItems)){var net=item.GetService<NetworkInterface>();if(net==null)continue;foreach(var node in net.Nodes){node.SetAttribute("Address",S(a,"address"));node.SetAttribute("SubnetMask",S(a,"mask"));if(node.ConnectedSubnet==null)node.ConnectToSubnet(subnet);nodes.Add(D("interface",item.Name,"name",node.Name,"address",node.GetAttribute("Address"),"mask",node.GetAttribute("SubnetMask"),"subnet",node.ConnectedSubnet.Name));}}
   if(nodes.Count!=1)throw new InvalidOperationException("Acceptance CPU must have exactly one network node");return D("nodes",nodes,"backup",backup);
  }
  if(op=="device_attributes")return D("name",cpu.Name,"attributes",cpu.GetAttributeInfos().Select(i=>D("name",i.Name,"accessMode",i.AccessMode.ToString(),"value",Regex.IsMatch(i.Name,"Password|Secret",RegexOptions.IgnoreCase)?"<redacted>":Convert.ToString(Attr(cpu,i.Name)))).ToArray());
  if(op=="initialize_test_security"){
   if(!B(a,"freshSimulation")||!createdProject)RequireTestProject();string backup=Backup();var configurator=cpu.GetService<PlcMasterSecretConfigurator>();if(configurator==null)throw new InvalidOperationException("CPU has no master-secret configurator");
   if(configurator.MasterSecretConfiguration==MasterSecretConfiguration.WithPassword)throw new InvalidOperationException("Existing configured password will not be changed");
   // Fresh isolated Softbus test CPUs have no physical endpoint. Configure the
   // intended lab access level explicitly; never apply this to user/physical projects.
   var accessProvider=cpu.GetService<PlcAccessLevelProvider>();if(accessProvider!=null)accessProvider.PlcProtectionAccessLevel=PlcProtectionAccessLevel.FullAccess;
   using(var random=RandomNumberGenerator.Create()){
    var bytes=new byte[24];random.GetBytes(bytes);var text="Tia!"+Convert.ToBase64String(bytes)+"a7";var encrypted=ProtectedData.Protect(Encoding.UTF8.GetBytes(text),null,DataProtectionScope.CurrentUser);
    Directory.CreateDirectory(Path.GetDirectoryName(TestSecretFile(cpu.Name)));File.WriteAllBytes(TestSecretFile(cpu.Name),encrypted);
    using(var password=new SecureString()){foreach(char ch in text)password.AppendChar(ch);password.MakeReadOnly();configurator.Protect(password);}
   }
   return D("configured",true,"backup",backup,"credentialFile",TestSecretFile(cpu.Name),"encryption","Windows DPAPI CurrentUser");
  }
  if(op=="blocks")return Blocks(plc.BlockGroup).Select(b=>D("name",b.Name,"number",b.Number,"language",b.ProgrammingLanguage.ToString(),"consistent",b.IsConsistent)).ToArray();
  if(op=="show_block"){
   var block=FindBlock(plc,S(a,"block"));block.ShowInEditor();
   return D("shown",true,"api","PlcBlock.ShowInEditor","cpu",cpu.Name,"block",block.Name,"number",block.Number,"language",block.ProgrammingLanguage.ToString());
  }
  if(op=="show_device"){
   string viewName=S(a,"view","Device");if(viewName!="Device"&&viewName!="Network")throw new ArgumentException("view must be Device or Network");
   IEngineeringObject ancestor=cpu;while(ancestor is DeviceItem)ancestor=((DeviceItem)ancestor).Parent;
   var device=ancestor as Device;if(device==null)throw new InvalidOperationException("The selected CPU has no owning hardware device");device.ShowInEditor((View)Enum.Parse(typeof(View),viewName));
   return D("shown",true,"api","Device.ShowInEditor","cpu",cpu.Name,"device",device.Name,"view",viewName);
  }
  if(op=="export_block"){
   var b=FindBlock(plc,S(a,"block"));b.Export(new FileInfo(S(a,"file")),ExportOptions.WithDefaults);
   return D("file",S(a,"file"),"name",b.Name,"language",b.ProgrammingLanguage.ToString());
  }
  if(op=="import_xml"){
   using(var access=portal.ExclusiveAccess("MCP import XML")){
    if(B(a,"replace")){
     var block=Blocks(plc.BlockGroup).Single(b=>b.Name==S(a,"replaceBlock"));Directory.CreateDirectory(backupRoot);
     var guard=new FileInfo(Path.Combine(backupRoot,"guard_"+Guid.NewGuid().ToString("N")+".xml"));block.Export(guard,ExportOptions.WithDefaults);
     var text=Regex.Replace(File.ReadAllText(guard.FullName),"<DocumentInfo>[\\s\\S]*?</DocumentInfo>","").Replace("\r\n","\n");
     string hash;using(var sha=SHA256.Create()){hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();}
     if(hash!=S(a,"expectedBlockSha256"))throw new InvalidOperationException("Block changed before exclusive import; nothing was replaced");
    }
    string backup=Backup();
    var imported=plc.BlockGroup.Blocks.Import(new FileInfo(S(a,"file")),B(a,"replace")?ImportOptions.Override:ImportOptions.None);
    return D("blocks",imported.Select(b=>b.Name).ToArray(),"backup",backup);
   }
  }
  if(op=="import_scl"){
   using(var access=portal.ExclusiveAccess("MCP generate SCL")){
    var sourceText=File.ReadAllText(S(a,"file"));sourceText=Regex.Replace(Regex.Replace(sourceText,@"\(\*[\s\S]*?\*\)",""),@"//[^\r\n]*","");
    foreach(Match match in Regex.Matches(sourceText,"^\\s*(?:FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK|TYPE)\\s+(?:\"([^\"]+)\"|([A-Za-z_][A-Za-z0-9_]*))",RegexOptions.Multiline|RegexOptions.IgnoreCase)){
     var name=match.Groups[1].Success?match.Groups[1].Value:match.Groups[2].Value;if(Blocks(plc.BlockGroup).Any(b=>b.Name==name))throw new InvalidOperationException("SCL would replace existing block "+name);
    }
    string backup=Backup();
    var source=plc.ExternalSourceGroup.ExternalSources.CreateFromFile(Path.GetFileNameWithoutExtension(S(a,"file"))+"_"+Guid.NewGuid().ToString("N").Substring(0,8),S(a,"file"));
    source.GenerateBlocksFromSource();return D("source",source.Name,"blocks",Blocks(plc.BlockGroup).Select(b=>b.Name).ToArray(),"backup",backup);
   }
  }
  if(op=="tags")return Tables(plc.TagTableGroup).Select(t=>D("table",t.Name,"tags",t.Tags.Select(tg=>D("name",tg.Name,"type",tg.DataTypeName,"address",tg.LogicalAddress)).ToArray())).ToArray();
  if(op=="add_tag"){
   string backup=Backup();using(var access=portal.ExclusiveAccess("MCP add tag")){
    var table=Tables(plc.TagTableGroup).SingleOrDefault(t=>t.Name==S(a,"table"))??plc.TagTableGroup.TagTables.Create(S(a,"table"));
    if(table.Tags.Find(S(a,"name"))!=null)throw new InvalidOperationException("Tag already exists; export and review before replacing.");
    var tg=table.Tags.Create(S(a,"name"),S(a,"type"),S(a,"address"));return D("name",tg.Name,"address",tg.LogicalAddress,"backup",backup);
   }
  }
  if(op=="compile"||op=="compile_save"){
   using(var access=portal.ExclusiveAccess(op=="compile_save"?"MCP compile and save":"MCP compile")){
    string backup=Backup();var result=CompileCpu(cpu,plc);
    bool compiled=(bool)result["success"],saved=false;string saveError=null;
    if(op=="compile_save"&&compiled)try{project.Save();saved=true;}catch(Exception e){saveError=e.Message;}
    // Keep verified compiler diagnostics even if the subsequent save fails.
    if(op=="compile_save")return D("success",compiled&&saved,"compiled",result,"saved",D("saved",saved,"path",project.Path.FullName,"backup",backup,"error",saveError),"backup",backup,"projectModified",project.IsModified,"saveSkippedReason",compiled?null:"Compile errors; project was not saved");
    result["backup"]=backup;result["saved"]=saved;result["path"]=project.Path.FullName;result["projectModified"]=project.IsModified;
    return result;
   }
  }
  if(op=="interfaces"){
   var provider=cpu.GetService<DownloadProvider>();
   return provider.Configuration.Modes.Select(m=>D("mode",m.Name,"interfaces",m.PcInterfaces.Select(p=>D("name",p.Name,"number",p.Number,"targets",p.TargetInterfaces.Select(t=>D("name",t.Name,"addresses",t.Addresses.Select(ad=>ad.Address).ToArray())).ToArray())).ToArray())).ToArray();
  }
  if(op=="online"){
   var online=cpu.GetService<OnlineProvider>();
   if(S(a,"action")=="connect"){var address=ResolveAddress(online.Configuration,a);online.Configuration.ApplyConfiguration(address);online.GoOnline();}
   else if(S(a,"action")=="disconnect")online.GoOffline();
   return D("state",online.State.ToString());
  }
  if(op=="download"){
   using(var access=portal.ExclusiveAccess("MCP download to verified target")){
   if(B(a,"physical")&&(project.IsModified||project.LastModified.ToUniversalTime().ToString("O")!=S(a,"lastModified")))throw new InvalidOperationException("Project changed after physical approval; download cancelled.");
   string backup=Backup();
   Dictionary<string,object> compiled=null;
   if(!B(a,"physical")){
    compiled=CompileCpu(cpu,plc);
    var hardware=compiled["hardware"] as Dictionary<string,object>;var software=(Dictionary<string,object>)compiled["software"];
    if(hardware==null||!(bool)compiled["success"])return D("state","CompileFailed","success",false,"downloaded",false,"compiled",compiled,"errors",(hardware==null?0:Convert.ToInt64(hardware["errors"]))+Convert.ToInt64(software["errors"]),"warnings",(hardware==null?0:Convert.ToInt64(hardware["warnings"]))+Convert.ToInt64(software["warnings"]),"backup",backup,"downloadSkippedReason",hardware==null?"Hardware compilation was unavailable; download requires verified hardware and software compilation":"Hardware or software compile errors; download was not attempted");
   }
   var provider=cpu.GetService<DownloadProvider>();var address=ResolveAddress(provider.Configuration,a);
   var events=new List<object>();SecureString downloadSecret=null;
   Action<DownloadConfiguration,string> trace=delegate(DownloadConfiguration c,string phase){events.Add(D("type",c.GetType().FullName,"phase",phase,"message",c.Message));File.WriteAllText(Path.Combine(backupRoot,"last-download-configurations.json"),json.Serialize(events));};
   bool legacyBefore=provider.Configuration.EnableLegacyCommunication;
   OnlineConfigurationDelegate onlineCallback=delegate(OnlineConfiguration c){
    events.Add(D("type",c.GetType().FullName,"phase","online"));File.WriteAllText(Path.Combine(backupRoot,"last-download-configurations.json"),json.Serialize(events));
    var tls=c as TlsVerificationConfiguration;
    if(tls!=null&&!B(a,"physical")){tls.CurrentSelection=TlsVerificationConfigurationSelection.Trusted;return;}
    throw new InvalidOperationException("Online authentication requires manual handling: "+c.GetType().Name);
   };
   try{
   if(!B(a,"physical"))provider.Configuration.OnlineLegitimation+=onlineCallback;
   if(!B(a,"physical"))provider.Configuration.EnableLegacyCommunication=false;
   if(!provider.Configuration.ApplyConfiguration((ConfigurationTargetInterface)address.Parent))throw new InvalidOperationException("TIA rejected the selected connection configuration");
   var result=provider.Download((IConfiguration)address.Parent,address,delegate(DownloadConfiguration c){
    trace(c,"pre");
    var master=c as PlcMasterSecretPassword;if(master!=null&&!B(a,"physical")){if(downloadSecret==null)downloadSecret=TestSecret(cpu.Name);master.SetPassword(downloadSecret);return;}
    if(!B(a,"physical")){
     var consistent=c as ConsistentBlocksDownload;if(consistent!=null){consistent.CurrentSelection=ConsistentBlocksDownloadSelections.ConsistentDownload;return;}
     var all=c as AllBlocksDownload;if(all!=null){all.CurrentSelection=AllBlocksDownloadSelections.DownloadAllBlocks;return;}
     var check=c as DownloadCheckConfiguration;if(check!=null){check.Checked=true;return;}
     var overwrite=c as OverwriteSystemData;if(overwrite!=null){overwrite.CurrentSelection=OverwriteSystemDataSelections.Overwrite;return;}
     var protection=c as ProtectionLevelChanged;if(protection!=null){protection.CurrentSelection=ProtectionLevelChangedSelections.ContinueDownloading;return;}
     var different=c as DifferentTargetConfiguration;if(different!=null){different.CurrentSelection=DifferentTargetConfigurationSelections.AcceptAll;return;}
     var texts=c as AlarmTextLibrariesDownload;if(texts!=null){texts.CurrentSelection=AlarmTextLibrariesDownloadSelections.ConsistentDownload;return;}
     var data=c as DataBlockReinitialization;if(data!=null){data.CurrentSelection=DataBlockReinitializationSelections.StopPlcAndReinitialize;return;}
     var expand=c as ExpandDownload;if(expand!=null){expand.CurrentSelection=ExpandDownloadSelections.Download;return;}
     var identification=c as LoadIdentificationData;if(identification!=null){identification.CurrentSelection=LoadIdentificationDataSelections.LoadData;return;}
    }
    var stop=c as StopModules;
    if(stop!=null){stop.CurrentSelection=StopModulesSelections.StopAll;return;}
    throw new InvalidOperationException("Download requires manual handling for "+c.GetType().Name+": "+c.Message+". No safety/password/protection prompts are auto-accepted.");
   },delegate(DownloadConfiguration c){
    trace(c,"post");
    var start=c as StartModules;
    if(start!=null){start.CurrentSelection=B(a,"startAfter")?StartModulesSelections.StartModule:StartModulesSelections.NoAction;return;}
    throw new InvalidOperationException("Unexpected post-download configuration: "+c.GetType().Name);
   },DownloadOptions.Hardware|DownloadOptions.Software);
   var downloaded=D("state",result.State.ToString(),"errors",result.ErrorCount,"warnings",result.WarningCount,"success",result.ErrorCount==0,"backup",backup);
   if(compiled!=null)downloaded["compiled"]=compiled;
   return downloaded;
   }finally{if(downloadSecret!=null)downloadSecret.Dispose();if(!B(a,"physical")){provider.Configuration.OnlineLegitimation-=onlineCallback;provider.Configuration.EnableLegacyCommunication=legacyBefore;}}
   }
  }
  throw new ArgumentException("Unsupported operation: "+op);
 }
 static void SetProject(Project next,bool fresh){project=next;projectIdentity=next==null?null:next.Path.FullName;createdProject=fresh;lastArchive=null;checkpointProject=null;}
 static void CheckProjectIdentity(string expected){
  string actual=project==null?null:Path.GetFullPath(project.Path.FullName);
  if(actual==null||!String.Equals(expected,actual,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PROJECT_IDENTITY_MISMATCH: The active project differs from expectedProjectPath. Expected: "+expected+"; actual: "+(actual??"<none>")+". This step was refused; inspect the active project before continuing.");
 }
 static void RefreshProject(){
  if(portal==null)return;
  var projects=portal.Projects.ToArray();Project next=null;
  if(projects.Length==1)next=projects[0];
  else if(projects.Length>1){var primary=projects.Where(p=>p.IsPrimary).ToArray();if(primary.Length!=1)throw new InvalidOperationException("The TIA session has multiple open projects without a unique primary project. Select a primary project in TIA before continuing.");next=primary[0];}
  string nextIdentity=next==null?null:next.Path.FullName;
  bool same=project==null&&next==null;
  if(project!=null&&next!=null&&String.Equals(projectIdentity,nextIdentity,StringComparison.OrdinalIgnoreCase))try{same=project.Equals(next);}catch{same=false;}
  if(!same)SetProject(next,false);else project=next;
 }
 static void ValidateSimValue(Dictionary<string,object> a){
  if(String.IsNullOrWhiteSpace(S(a,"tag")))throw new ArgumentException("A nonempty symbolic tag name is required");
  string type=S(a,"type");if(type!="Bool"&&type!="Int"&&type!="DInt"&&type!="Real")throw new ArgumentException("Unsupported data type; use Bool, Int, DInt or Real");
  if(a.ContainsKey("write")&&!(a["write"] is bool))throw new ArgumentException("write must be a Boolean");
  if(!B(a,"write"))return;
  if(!a.ContainsKey("value")||a["value"]==null)throw new ArgumentException("Write requires value");
  object value=a["value"];
  if(type=="Bool"){if(!(value is bool))throw new ArgumentException("Bool variable requires a Boolean value");return;}
  if(value is bool||value is string||!(value is IConvertible))throw new ArgumentException("Numeric PLC variable requires a JSON number");
  double number=Convert.ToDouble(value);
  if(Double.IsNaN(number)||Double.IsInfinity(number))throw new ArgumentException("PLC numeric value must be finite");
  if(type=="Real"){if(Math.Abs(number)>Single.MaxValue)throw new ArgumentException("Real value out of range");return;}
  if(number!=Math.Truncate(number))throw new ArgumentException("Integer PLC variable requires an integer value");
  if(type=="Int"&&(number<Int16.MinValue||number>Int16.MaxValue))throw new ArgumentException("Int value out of range [-32768, 32767]");
  if(type=="DInt"&&(number<Int32.MinValue||number>Int32.MaxValue))throw new ArgumentException("DInt value out of range [-2147483648, 2147483647]");
 }
 static object ReadSimValue(Sim.IInstance inst,Dictionary<string,object> a){
  string tag=S(a,"tag");switch(S(a,"type")){case "Bool":return inst.ReadBool(tag);case "Int":return inst.ReadInt16(tag);case "DInt":return inst.ReadInt32(tag);case "Real":return inst.ReadFloat(tag);default:throw new ArgumentException("Unsupported data type");}
 }
 static void WriteSimValue(Sim.IInstance inst,Dictionary<string,object> a){
  string tag=S(a,"tag");switch(S(a,"type")){case "Bool":inst.WriteBool(tag,(bool)a["value"]);break;case "Int":inst.WriteInt16(tag,Convert.ToInt16(a["value"]));break;case "DInt":inst.WriteInt32(tag,Convert.ToInt32(a["value"]));break;case "Real":inst.WriteFloat(tag,Convert.ToSingle(a["value"]));break;default:throw new ArgumentException("Unsupported data type");}
 }
 static Dictionary<string,object> CompileCpu(DeviceItem cpu,PlcSoftware plc){
  var hw=cpu.GetService<ICompilable>();var hwResult=hw==null?null:hw.Compile();var result=plc.GetService<ICompilable>().Compile();
  return D("hardware",hwResult==null?null:CompileResult(hwResult),"software",CompileResult(result),"hardwareUnavailable",hwResult==null,"success",hwResult!=null&&hwResult.ErrorCount==0&&result.ErrorCount==0);
 }
 static PlcBlock FindBlock(PlcSoftware plc,string name){
  if(String.IsNullOrWhiteSpace(name))throw new ArgumentException("A block name is required; list blocks first");
  var matches=Blocks(plc.BlockGroup).Where(b=>b.Name==name).ToArray();
  if(matches.Length==0)throw new ArgumentException("Block not found: "+name+". List the selected CPU's blocks first.");
  if(matches.Length!=1)throw new ArgumentException("Block name is ambiguous: "+name);
  return matches[0];
 }
 static Sim.IInstance SimInstance(string name){if(!name.StartsWith("CodexMCP_",StringComparison.Ordinal))throw new InvalidOperationException("Only CodexMCP_ simulation instances may be controlled.");Sim.IInstance inst;if(!simulationHandles.TryGetValue(name,out inst)){inst=Sim.SimulationRuntimeManager.CreateInterface(name);simulationHandles[name]=inst;}return inst;}
 static void RequireTestProject(){
  var expected=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","projects","acceptance"))+Path.DirectorySeparatorChar;
  if(!project.Name.StartsWith("MCP_V18_",StringComparison.Ordinal)||!project.Path.FullName.StartsWith(expected,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("This operation is restricted to isolated MCP acceptance projects");
 }
 static string TestSecretFile(string cpu){using(var sha=SHA256.Create()){var key=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(project.Path.FullName.ToUpperInvariant()+"|"+cpu))).Replace("-","").ToLowerInvariant();return Path.Combine(backupRoot,"test-security",key+".dpapi");}}
 static SecureString TestSecret(string cpu){var file=TestSecretFile(cpu);if(!File.Exists(file)){RequireTestProject();file=Path.Combine(backupRoot,"test-security",project.Name+".dpapi");}var bytes=ProtectedData.Unprotect(File.ReadAllBytes(file),null,DataProtectionScope.CurrentUser);var result=new SecureString();foreach(char ch in Encoding.UTF8.GetString(bytes))result.AppendChar(ch);Array.Clear(bytes,0,bytes.Length);result.MakeReadOnly();return result;}
 static ConfigurationAddress ResolveAddress(ConnectionConfiguration cfg,Dictionary<string,object>a){
  var mode=cfg.Modes.Find(S(a,"mode"));if(mode==null)throw new ArgumentException("Mode not found; enumerate interfaces first.");
  var pc=mode.PcInterfaces.Find(S(a,"interface"),N(a,"interfaceNumber",1));if(pc==null)throw new ArgumentException("PC interface not found.");
  var target=pc.TargetInterfaces.Find(S(a,"targetInterface"));if(target==null)throw new ArgumentException("Target interface not found.");
  return target.Addresses.Find(S(a,"address"))??target.Addresses.Create(S(a,"address"));
 }
 static IEnumerable<DeviceItem> Items(DeviceItemComposition items){foreach(var i in items){yield return i;foreach(var child in Items(i.DeviceItems))yield return child;}}
 static PlcSoftware GetPlc(DeviceItem i){var c=i.GetService<SoftwareContainer>();return c==null?null:c.Software as PlcSoftware;}
 static DeviceItem FindCpu(string name){
  var cpus=project.Devices.SelectMany(d=>Items(d.DeviceItems)).Where(i=>GetPlc(i)!=null).ToArray();
  if(cpus.Length==0)throw new InvalidOperationException("NO_PLC_IN_PROJECT: This project contains no PLC CPU with PLC software. Add a CPU from an exact installed catalog identifier before programming or compiling.");
  if(String.IsNullOrWhiteSpace(name)&&cpus.Length==1)return cpus[0];
  string available=String.Join(", ",cpus.Select(i=>i.Name+" (software: "+GetPlc(i).Name+")"));
  if(String.IsNullOrWhiteSpace(name))throw new ArgumentException("CPU_REQUIRED: Multiple PLCs exist; specify cpu explicitly. Available: "+available);
  var matches=cpus.Where(i=>i.Name==name||GetPlc(i).Name==name).ToArray();
  if(matches.Length==0)throw new ArgumentException("CPU_NOT_FOUND: "+name+". Available: "+available);
  if(matches.Length>1)throw new ArgumentException("CPU_AMBIGUOUS: "+name+" matches more than one PLC. Available: "+available);
  return matches[0];
 }
 static IEnumerable<PlcBlock> Blocks(PlcBlockGroup group){foreach(var b in group.Blocks)yield return b;foreach(var g in group.Groups)foreach(var b in Blocks(g))yield return b;}
 static IEnumerable<PlcTagTable> Tables(PlcTagTableGroup group){foreach(var t in group.TagTables)yield return t;foreach(var g in group.Groups)foreach(var t in Tables(g))yield return t;}
 static object Attr(IEngineeringObject obj,string name){try{return obj.GetAttribute(name);}catch{return null;}}
 static object CompileResult(CompilerResult r){return D("state",r.State.ToString(),"errors",r.ErrorCount,"warnings",r.WarningCount,"messages",Messages(r.Messages));}
 static object[] Messages(CompilerResultMessageComposition messages){return messages.Select(m=>D("description",m.Description,"path",m.Path,"state",m.State.ToString(),"children",Messages(m.Messages))).Cast<object>().ToArray();}
 static string Backup(){
  NeedProject();if(String.IsNullOrEmpty(backupRoot))throw new InvalidOperationException("Backup directory is not configured.");
  // Siemens Archive requires a saved project. During a staged, unsaved batch retain
  // the verified pre-change archive instead of silently saving user work.
  if(project.IsModified){
   if(checkpointProject==project.Path.FullName&&lastArchive!=null&&File.Exists(lastArchive))return lastArchive;
   throw new InvalidOperationException("Project has pre-existing unsaved changes and no verified MCP checkpoint. Save it explicitly in TIA first; no implicit save or write was performed.");
  }
  Directory.CreateDirectory(backupRoot);string name=project.Name+"_"+DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff")+"_"+Guid.NewGuid().ToString("N").Substring(0,8);
  string filename=name+".zap18";project.Archive(new DirectoryInfo(backupRoot),filename,ProjectArchivationMode.Compressed);
  string archive=Path.Combine(backupRoot,filename);if(!File.Exists(archive)||new FileInfo(archive).Length==0)throw new IOException("Project archive could not be verified; no write will continue");lastArchive=archive;checkpointProject=project.Path.FullName;return archive;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string path,IntPtr reserved,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr lib,string name);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr lib);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate IntPtr CreateClient();
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void DestroyClient(ref IntPtr client);
 [UnmanagedFunctionPointer(CallingConvention.StdCall,CharSet=CharSet.Ansi)] delegate int ConnectClient(IntPtr client,string address,int rack,int slot);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ClientAction(IntPtr client);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ClientStatus(IntPtr client,out int state);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ClientInfo(IntPtr client,IntPtr data);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ClientParam(IntPtr client,int param,ref int value);
 [UnmanagedFunctionPointer(CallingConvention.StdCall,CharSet=CharSet.Ansi)] delegate int ErrorText(int error,StringBuilder text,int len);
 static T Native<T>(IntPtr dll,string name) where T:class {var p=GetProcAddress(dll,name);if(p==IntPtr.Zero)throw new InvalidOperationException("Missing Snap7 symbol "+name);return Marshal.GetDelegateForFunctionPointer(p,typeof(T)) as T;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi,Pack=1)] struct CpuInfo {
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=33)]public string ModuleTypeName;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=25)]public string SerialNumber;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=25)]public string ASName;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=27)]public string Copyright;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=25)]public string ModuleName;
 }
 static object PhysicalLibrary(string library){
  if(!Path.IsPathRooted(library)||!File.Exists(library))throw new ArgumentException("Snap7 library not installed");
  IntPtr dll=LoadLibraryEx(library,IntPtr.Zero,8);if(dll==IntPtr.Zero)throw new InvalidOperationException("Cannot load x64 Snap7 DLL");
  try{
   foreach(string symbol in new[]{"Cli_Create","Cli_Destroy","Cli_ConnectTo","Cli_Disconnect","Cli_GetCpuInfo","Cli_GetOrderCode","Cli_PlcHotStart","Cli_PlcStop","Cli_GetPlcStatus","Cli_SetParam","Cli_ErrorText"})if(GetProcAddress(dll,symbol)==IntPtr.Zero)throw new InvalidOperationException("Missing symbol "+symbol);
   var client=Native<CreateClient>(dll,"Cli_Create")();if(client==IntPtr.Zero)throw new InvalidOperationException("Cannot create client");Native<DestroyClient>(dll,"Cli_Destroy")(ref client);
   return D("loaded",true,"symbolsValid",true,"x64",true,"networkToPlcPerformed",false,"hardwareValidated",false);
  }finally{FreeLibrary(dll);}
 }
 static object Physical(Dictionary<string,object>a){
  string library=S(a,"library");if(!Path.IsPathRooted(library)||!File.Exists(library))throw new ArgumentException("Expected full installed Snap7 DLL path");
  IntPtr dll=LoadLibraryEx(library,IntPtr.Zero,8);if(dll==IntPtr.Zero)throw new InvalidOperationException("Cannot load x64 Snap7 library, Windows error "+Marshal.GetLastWin32Error());
  IntPtr client=IntPtr.Zero;
  try {
   var errors=Native<ErrorText>(dll,"Cli_ErrorText");Action<int> check=delegate(int code){if(code!=0){var text=new StringBuilder(1024);errors(code,text,1024);throw new InvalidOperationException("Snap7: "+text);}};
   client=Native<CreateClient>(dll,"Cli_Create")();if(client==IntPtr.Zero)throw new InvalidOperationException("Cannot create Snap7 client");
   int timeout=3000;foreach(int p in new[]{3,4,5})check(Native<ClientParam>(dll,"Cli_SetParam")(client,p,ref timeout));
   check(Native<ConnectClient>(dll,"Cli_ConnectTo")(client,S(a,"address"),N(a,"rack",0),N(a,"slot",1)));
   IntPtr data=Marshal.AllocHGlobal(1024);
   CpuInfo info;string firmware;
   try {
    check(Native<ClientInfo>(dll,"Cli_GetCpuInfo")(client,data));info=(CpuInfo)Marshal.PtrToStructure(data,typeof(CpuInfo));
    check(Native<ClientInfo>(dll,"Cli_GetOrderCode")(client,data));firmware=Marshal.ReadByte(data,21)+"."+Marshal.ReadByte(data,22)+"."+Marshal.ReadByte(data,23);
   }finally{Marshal.FreeHGlobal(data);}
   if(info.SerialNumber.Trim()!=S(a,"serial")||info.ModuleTypeName.Trim()!=S(a,"model")||firmware!=S(a,"firmware"))throw new InvalidOperationException("Physical CPU serial/model/firmware mismatch. Nothing was written.");
   string action=S(a,"action");
   if(action=="run")check(Native<ClientAction>(dll,"Cli_PlcHotStart")(client));
   else if(action=="stop")check(Native<ClientAction>(dll,"Cli_PlcStop")(client));
   else if(action!="inspect")throw new ArgumentException("Unknown physical action");
   int state;check(Native<ClientStatus>(dll,"Cli_GetPlcStatus")(client,out state));
   if(action=="run"&&state!=8||action=="stop"&&state!=4)throw new InvalidOperationException("PLC state readback did not match requested state");
   return D("serial",info.SerialNumber,"model",info.ModuleTypeName,"firmware",firmware,"address",S(a,"address"),"state",state==8?"RUN":state==4?"STOP":"UNKNOWN","hardwareValidated",false);
  }finally{if(client!=IntPtr.Zero){Native<ClientAction>(dll,"Cli_Disconnect")(client);Native<DestroyClient>(dll,"Cli_Destroy")(ref client);}FreeLibrary(dll);}
 }
}
