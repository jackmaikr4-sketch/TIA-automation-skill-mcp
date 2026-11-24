import { WorkerClient, config, root } from '../src/runtime.mjs';
import fs from 'node:fs/promises';
const worker = new WorkerClient();
try {
  const report = {
    checkedAt: new Date().toISOString(),
    root,
    node: process.version,
    api: config.tiaApiDirectory,
  };
  report.environment = await worker.call('diagnose');
  try {
    report.instances = await worker.call('processes');
  } catch (e) {
    report.instancesError = e.message;
  }
  try {
    report.simulation = await worker.call('sim_list');
  } catch (e) {
    report.simulationError = e.message;
  }
  report.readyForTia = report.environment.opennessTokenMember;
  await fs.writeFile(
    new URL('../artifacts/doctor.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.readyForTia) process.exitCode = 2;
} finally {
  worker.close();
}
