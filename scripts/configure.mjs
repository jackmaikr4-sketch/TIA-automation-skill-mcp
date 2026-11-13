import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(path.join(root,'projects'),{recursive:true});
const config={tiaApiDirectory:'C:/Program Files/Siemens/Automation/Portal V18/PublicAPI/V18',simulationApiDirectory:'C:/Program Files (x86)/Common Files/Siemens/PLCSIMADV/API/4.1',allowedRoots:[path.join(root,'projects')],operationTimeoutMs:180000,physicalTargets:[],snap7Library:path.join(root,'vendor/snap7/snap7.dll'),simulationNetwork:{communication:'Softbus',adapter:'Siemens PLCSIM Virtual Ethernet Adapter',hostAddress:'192.168.250.1',address:'192.168.250.2',mask:'255.255.255.0'}};
try{await fs.writeFile(path.join(root,'config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});console.log('Created config.json. Edit the two Siemens API paths before building.');}
catch(e){if(e.code!=='EEXIST')throw e;console.log('Keeping existing config.json.');}
