import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectAccess, classifyToolError } from '../src/project-access.mjs';

test('session project grants require exact attached identity and never grant sibling projects or source roots', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tia-scope-'));
  const project = path.join(folder, 'UserProject.ap18'),
    sibling = path.join(folder, 'Other.ap18');
  await fs.writeFile(project, 'fixture');
  await fs.writeFile(sibling, 'fixture');
  const scope = new ProjectAccess([path.join(folder, 'permitted')]);
  try {
    assert.equal((await scope.inspect(project)).allowed, false);
    await assert.rejects(scope.grant(project, sibling), /does not match/);
    await assert.rejects(scope.grant(path.join(folder, 'x.scl'), project), /\.ap18/);
    const receipt = await scope.grant(project, project);
    assert.equal(receipt.persistentConfigurationChanged, false);
    assert.equal((await scope.inspect(project)).scope, 'attached_project_session');
    assert.equal((await scope.inspect(sibling)).allowed, false);
    assert.equal((await scope.inspect(path.join(folder, 'secret.txt'))).allowed, false);
    scope.clear();
    await assert.rejects(scope.assert(project), { code: 'PROJECT_SCOPE_REQUIRED' });
  } finally {
    await fs.unlink(project);
    await fs.unlink(sibling);
    await fs.rmdir(folder);
  }
});

test('error recovery distinguishes definitely unexecuted busy calls from unknown timeout outcomes', () => {
  const busy = classifyToolError(Error('MCP_BUSY_BEFORE_EXECUTION: another TIA operation'));
  assert.equal(busy.code, 'TIA_BUSY');
  assert.equal(busy.retryable, true);
  const timeout = classifyToolError(Error('TIA operation timed out'));
  assert.equal(timeout.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(timeout.retryable, false);
  const network = classifyToolError(Error('Error Code -50, VirtualSwitchMisconfigured'));
  assert.equal(network.code, 'SIM_VIRTUAL_SWITCH_CONFIGURATION');
  assert.match(network.recovery.message, /Softbus/);
});
