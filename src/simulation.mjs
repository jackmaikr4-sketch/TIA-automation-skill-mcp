// Local PLCSIM workflows. invoke() calls existing internal tool handlers, not the
// public MCP queue. The caller keeps the same WorkerClient alive throughout.
const TYPES = new Set(['Bool', 'Int', 'DInt', 'Real']);
const CPU_TYPES = new Set(['CPU1511', 'CPU1513', 'CPU1515', 'CPU1516', 'CPU1517', 'CPU1518']);
const FLOAT_MAX = 3.4028234663852886e38;
const NAME = /^CodexMCP_[A-Za-z0-9_]{1,50}$/;
const LOCAL_INTERFACE = /^PLCSIM(?:[. ]|$)/i;
const LOCAL_MODE = /^(PN\/IE|MPI|S7ONLINE)$/i;
const VIRTUAL_ADAPTER = 'Siemens PLCSIM Virtual Ethernet Adapter';
export const simulationLimits = Object.freeze({
  batchItems: 100,
  steps: 100,
  totalScenarioItems: 1000,
  stepWaitMs: 10000,
  totalWaitMs: 60000,
  pulseMs: 10000,
});

export class SimulationWorkflowError extends Error {
  constructor(code, message, recovery, details = {}) {
    super(message);
    this.name = 'SimulationWorkflowError';
    this.code = code;
    this.recovery = recovery;
    this.details = details;
  }
}
function fail(code, message, recovery, details) {
  throw new SimulationWorkflowError(code, message, recovery, details);
}
function errorInfo(error) {
  return {
    code: error?.code || 'SIMULATION_OPERATION_FAILED',
    message: error?.message || String(error),
    ...(error?.recovery ? { recovery: error.recovery } : {}),
    ...(error?.details ? { details: error.details } : {}),
  };
}
function validateName(name) {
  if (typeof name !== 'string' || !NAME.test(name))
    throw new TypeError('Expected an MCP-owned CodexMCP_ simulation name');
}
function validateCpu(cpu, required = false) {
  if (cpu === undefined || cpu === '') {
    if (required) throw new TypeError('An explicit offline CPU name is required');
    return;
  }
  if (typeof cpu !== 'string' || !cpu.trim()) throw new TypeError('CPU must be a nonempty name');
}
function validateTag(item, withValue = false) {
  if (
    !item ||
    typeof item !== 'object' ||
    typeof item.tag !== 'string' ||
    !item.tag.trim() ||
    item.tag.length > 1024
  )
    throw new TypeError('Each item requires a nonempty symbolic tag');
  if (!TYPES.has(item.type)) throw new TypeError('Tag type must be Bool, Int, DInt or Real');
  if (withValue) validateSimulationValue(item.type, item.value);
  return { ...item };
}
export function validateSimulationValue(type, value) {
  if (!TYPES.has(type)) throw new TypeError('Unsupported PLC type');
  if (type === 'Bool') {
    if (typeof value !== 'boolean') throw new TypeError('Bool requires a boolean');
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(type + ' requires a finite number');
  if (type === 'Real') {
    if (Math.abs(value) > FLOAT_MAX)
      throw new RangeError('Real value exceeds IEEE 754 single precision range');
    return value;
  }
  if (!Number.isInteger(value)) throw new TypeError(type + ' requires an integer');
  const [min, max] = type === 'Int' ? [-32768, 32767] : [-2147483648, 2147483647];
  if (value < min || value > max) throw new RangeError(type + ' value is out of range');
  return value;
}
function validateBatch(items, withValue = false, { allowEmpty = false, label = 'items' } = {}) {
  if (
    !Array.isArray(items) ||
    items.length > simulationLimits.batchItems ||
    (!allowEmpty && !items.length)
  )
    throw new TypeError(
      label +
        ' must contain ' +
        (allowEmpty ? '0' : '1') +
        ' to ' +
        simulationLimits.batchItems +
        ' items',
    );
  const copy = items.map((item) => validateTag(item, withValue));
  const seen = new Set();
  for (const item of copy) {
    if (seen.has(item.tag)) throw new TypeError('Duplicate tag in ' + label + ': ' + item.tag);
    seen.add(item.tag);
  }
  return copy;
}
function nonnegativeMs(value, max, label) {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError(label + ' must be an integer from 0 to ' + max + ' milliseconds');
  return value;
}
function ipv4(value) {
  return (
    typeof value === 'string' &&
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) &&
    value.split('.').every((p) => +p <= 255) &&
    value !== '0.0.0.0'
  );
}
function equalValue(type, actual, expected, tolerance) {
  if (type !== 'Real') return actual === expected;
  return tolerance === undefined
    ? actual === Math.fround(expected)
    : Math.abs(actual - expected) <= tolerance;
}
function typedRead(result, item) {
  if (!result || !Object.hasOwn(result, 'value'))
    throw new Error('No value was returned for ' + item.tag);
  validateSimulationValue(item.type, result.value);
  return result.value;
}

/** Read-only collision checks immediately before download. readStatus receives
 * an instance name. No other simulator is stopped or reconfigured. */
export async function assertSimulationDownloadTarget({
  name,
  cpu,
  address,
  status,
  offlineAddresses,
  instances,
  assertOwned,
  readStatus,
}) {
  validateName(name);
  validateCpu(cpu, true);
  if (typeof assertOwned !== 'function' || typeof readStatus !== 'function')
    throw new TypeError('assertOwned and readStatus must be functions');
  const recovery =
    'Inspect the listed local simulations and offline CPU addresses. Use distinct controllers and IP addresses; no other instance was changed.';
  const reject = (code, message, details = {}) =>
    fail(code, message, recovery, { name, cpu, address, ...details });
  async function owned(instanceName) {
    try {
      validateName(instanceName);
      await assertOwned(instanceName);
    } catch (error) {
      reject(
        'SIMULATION_INSTANCE_NOT_OWNED',
        'Download cannot be isolated while an unowned or unknown simulation is registered',
        { instance: instanceName, cause: errorInfo(error) },
      );
    }
  }
  function addresses(values, label, instanceName) {
    if (!Array.isArray(values) || !values.length || values.some((value) => !ipv4(value)))
      reject(
        'SIMULATION_ADDRESSES_UNKNOWN',
        label + ' must contain only known, usable IPv4 addresses',
        { instance: instanceName, addresses: values },
      );
    return [...new Set(values.map((value) => value.split('.').map(Number).join('.')))];
  }
  await owned(name);
  if (!status || status.name !== name)
    reject(
      'SIMULATION_IDENTITY_MISMATCH',
      'The selected simulation identity could not be confirmed',
      { actual: status?.name },
    );
  if (status.state === 'Off')
    reject('SIMULATION_POWERED_OFF', 'The selected simulation must be powered on before download');
  if (typeof status.state !== 'string' || !status.state)
    reject('SIMULATION_STATE_UNKNOWN', 'The selected simulation operating state is unknown');
  if (!['Softbus', 'TCPIP'].includes(status.communication))
    reject(
      'UNSUPPORTED_SIMULATION_CHANNEL',
      'The selected simulator has no supported communication channel',
      { communication: status.communication },
    );
  if (status.type && status.controller !== cpu)
    reject(
      'SIMULATION_CPU_MISMATCH',
      'The selected simulation controller does not match the offline CPU',
      { actual: status.controller },
    );
  const targetAddresses = addresses(status.addresses, 'The selected simulation', name);
  if (!ipv4(address) || !targetAddresses.includes(address.split('.').map(Number).join('.')))
    reject(
      'SIMULATION_ADDRESS_MISMATCH',
      'The download address is not a current address of the selected simulation',
      { targetAddresses },
    );
  const finalAddresses = addresses(offlineAddresses, 'The offline CPU', cpu);
  if (!Array.isArray(instances) || !instances.some((instance) => instance?.name === name))
    reject(
      'SIMULATION_INSTANCE_LIST_INCOMPLETE',
      'The selected simulation was not found in the current instance list',
    );
  const reserved = new Set([...targetAddresses, ...finalAddresses]),
    checkedOtherInstances = [];
  for (const instance of instances) {
    if (instance?.name === name) continue;
    const instanceName = instance?.name;
    await owned(instanceName);
    let other;
    try {
      other = await readStatus(instanceName);
    } catch (error) {
      reject(
        'SIMULATION_INSTANCE_UNINSPECTABLE',
        'Another simulation could not be inspected before download',
        { instance: instanceName, cause: errorInfo(error) },
      );
    }
    if (!other || other.name !== instanceName)
      reject('SIMULATION_IDENTITY_MISMATCH', 'Another simulation identity could not be confirmed', {
        instance: instanceName,
        actual: other?.name,
      });
    if (other.state === 'Off') {
      checkedOtherInstances.push({ name: instanceName, state: 'Off', conflictCheckSkipped: true });
      continue;
    }
    if (typeof other.state !== 'string' || !other.state)
      reject('SIMULATION_STATE_UNKNOWN', 'Another simulation operating state is unknown', {
        instance: instanceName,
      });
    const otherAddresses = addresses(other.addresses, 'Another powered simulation', instanceName);
    if (other.communication !== status.communication)
      reject(
        'SIMULATION_CHANNEL_AMBIGUOUS',
        'Powered simulations use different communication channels; target isolation is not confirmed',
        {
          instance: instanceName,
          targetCommunication: status.communication,
          otherCommunication: other.communication,
        },
      );
    if (other.controller === cpu)
      reject(
        'SIMULATION_CONTROLLER_CONFLICT',
        'Another powered simulation uses the offline CPU controller name',
        { instance: instanceName, controller: other.controller },
      );
    const conflicts = otherAddresses.filter((ip) => reserved.has(ip));
    if (conflicts.length)
      reject(
        'SIMULATION_ADDRESS_CONFLICT',
        'Another powered simulation shares a current or final offline CPU address',
        {
          instance: instanceName,
          conflicts,
          targetAddresses,
          offlineAddresses: finalAddresses,
          otherAddresses,
        },
      );
    checkedOtherInstances.push({
      name: instanceName,
      state: other.state,
      controller: other.controller,
      communication: other.communication,
      addresses: otherAddresses,
    });
  }
  return {
    name,
    cpu,
    address,
    communication: status.communication,
    targetAddresses,
    offlineAddresses: finalAddresses,
    checkedOtherInstances,
    isolated: true,
  };
}

/** Select only interfaces actually enumerated by TIA and addresses returned by
 * the owned simulator. Empty/cached TIA address lists never supply a guessed IP. */
export function selectSimulationRoute({ interfaces, status, cpu, config = {}, selection = {} }) {
  validateCpu(cpu, true);
  if (!status || !['Softbus', 'TCPIP'].includes(status.communication))
    fail(
      'UNSUPPORTED_SIMULATION_CHANNEL',
      'The simulator did not report a supported local communication channel',
      'Inspect the owned PLCSIM instance; do not use a physical adapter.',
    );
  const addresses = [...new Set((status.addresses || []).filter(ipv4))];
  if (!addresses.length)
    fail(
      'SIMULATION_ADDRESS_UNAVAILABLE',
      'The owned simulator has no usable IPv4 address',
      'Power on the owned instance and read its status again; do not guess an address.',
    );
  let allowedAddresses = addresses;
  const network = config.simulationNetwork;
  if (status.communication === 'TCPIP') {
    if (!network || network.adapter !== VIRTUAL_ADAPTER || !ipv4(network.address))
      fail(
        'SIMULATION_NETWORK_UNCONFIGURED',
        'The dedicated Siemens virtual network is not configured',
        'Use a new Softbus instance, or explicitly configure the dedicated virtual simulation network.',
      );
    if (!addresses.includes(network.address))
      fail(
        'SIMULATION_ADDRESS_MISMATCH',
        'The owned simulator does not have the configured private test address',
        'Use tia_sim_set_ip on this owned instance, then inspect its address again.',
        { actual: addresses, configured: network.address },
      );
    allowedAddresses = [network.address];
  }
  const candidates = [];
  for (const mode of interfaces || []) {
    if (!LOCAL_MODE.test(mode.mode || '')) continue;
    for (const pc of mode.interfaces || []) {
      const allowed =
        status.communication === 'Softbus'
          ? LOCAL_INTERFACE.test(pc.name || '')
          : pc.name === network.adapter;
      if (!allowed || !Number.isInteger(pc.number) || pc.number < 1) continue;
      for (const target of pc.targets || []) {
        if (typeof target.name !== 'string' || !target.name) continue;
        // A known current controller address is authoritative; TIA may expose an
        // empty address list before the initial connection or retain an old address.
        for (const address of allowedAddresses)
          candidates.push({
            cpu,
            mode: mode.mode,
            interface: pc.name,
            interfaceNumber: pc.number,
            targetInterface: target.name,
            address,
          });
      }
    }
  }
  let unique = [...new Map(candidates.map((route) => [JSON.stringify(route), route])).values()];
  for (const key of ['mode', 'interface', 'interfaceNumber', 'targetInterface', 'address'])
    if (selection[key] !== undefined)
      unique = unique.filter((route) => route[key] === selection[key]);
  if (!selection.mode && unique.some((route) => route.mode === 'PN/IE'))
    unique = unique.filter((route) => route.mode === 'PN/IE');
  if (!unique.length)
    fail(
      'SIMULATION_INTERFACE_UNAVAILABLE',
      'TIA did not enumerate a matching local PLCSIM download interface',
      'Keep the owned simulator powered on and the MCP connection alive, then enumerate interfaces again. For Softbus choose an enumerated PLCSIM interface; never substitute a physical adapter.',
      { communication: status.communication, addresses, enumerated: interfaces, selection },
    );
  if (unique.length !== 1)
    fail(
      'SIMULATION_ROUTE_AMBIGUOUS',
      'More than one enumerated simulation route matches the owned controller',
      'Select mode, interfaceNumber, targetInterface or address from the returned candidates.',
      { candidates: unique },
    );
  return unique[0];
}

export function validateScenario({ steps, cleanup = [] }) {
  if (!Array.isArray(steps) || !steps.length || steps.length > simulationLimits.steps)
    throw new TypeError('Scenario requires 1 to ' + simulationLimits.steps + ' steps');
  let totalWaitMs = 0,
    totalItems = 0;
  const normalized = steps.map((step, index) => {
    if (!step || typeof step !== 'object') throw new TypeError('Invalid scenario step');
    const label = step.label ?? 'Step ' + (index + 1);
    if (typeof label !== 'string' || !label.trim() || label.length > 300)
      throw new TypeError('Step label must be nonempty text up to 300 characters');
    const writes = validateBatch(step.writes || [], true, {
      allowEmpty: true,
      label: 'step writes',
    });
    const expect = validateBatch(step.expect, true, { label: 'step expectations' });
    for (const item of expect)
      if (
        item.tolerance !== undefined &&
        (item.type !== 'Real' ||
          typeof item.tolerance !== 'number' ||
          !Number.isFinite(item.tolerance) ||
          item.tolerance < 0)
      )
        throw new TypeError('Only Real expectations support a finite nonnegative tolerance');
    const waitMs = nonnegativeMs(step.waitMs ?? 200, simulationLimits.stepWaitMs, 'Step wait');
    totalWaitMs += waitMs;
    totalItems += writes.length + expect.length;
    return { label, writes, expect, waitMs };
  });
  const cleanupWrites = validateBatch(cleanup, true, { allowEmpty: true, label: 'cleanup' });
  totalItems += cleanupWrites.length;
  if (totalWaitMs > simulationLimits.totalWaitMs)
    throw new RangeError(
      'Total scenario wait exceeds ' + simulationLimits.totalWaitMs + ' milliseconds',
    );
  if (totalItems > simulationLimits.totalScenarioItems)
    throw new RangeError(
      'Scenario exceeds ' + simulationLimits.totalScenarioItems + ' total read/write items',
    );
  return { steps: normalized, cleanup: cleanupWrites, totalWaitMs, totalItems };
}

/** Calls are serialized per workflow instance. Batch writes and snapshots are
 * intentionally described as non-atomic; another client/PLC scan can intervene. */
export function createSimulationWorkflow({
  invoke,
  assertOwned,
  config = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (
    typeof invoke !== 'function' ||
    typeof assertOwned !== 'function' ||
    typeof sleep !== 'function'
  )
    throw new TypeError('invoke, assertOwned and sleep must be functions');
  let queue = Promise.resolve();
  const serial = (fn) => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };
  async function inspect(name, cpu, { program = true, run = false, allowOff = false } = {}) {
    validateName(name);
    validateCpu(cpu);
    await assertOwned(name);
    const status = await invoke('tia_sim_control', { name, action: 'status' });
    if (status?.name !== name)
      fail(
        'SIMULATION_IDENTITY_MISMATCH',
        'Simulator name readback does not match the requested instance',
        'Inspect the local instances before retrying.',
        { requested: name, actual: status?.name },
      );
    if (!['Softbus', 'TCPIP'].includes(status.communication))
      fail(
        'UNSUPPORTED_SIMULATION_CHANNEL',
        'Only local PLCSIM Softbus or the configured virtual TCP/IP channel is supported',
        'Inspect the selected owned instance.',
      );
    if (!allowOff && status.state === 'Off')
      fail(
        'SIMULATION_POWERED_OFF',
        'The owned simulation is powered off',
        'Power on this owned simulation before reading or writing variables.',
      );
    if (program && !status.type)
      fail(
        'SIMULATION_PROGRAM_MISSING',
        'The owned simulation has no downloaded PLC program',
        'Compile and download the selected offline CPU first.',
      );
    if (status.type && cpu && status.controller !== cpu)
      fail(
        'SIMULATION_CPU_MISMATCH',
        'The owned simulation controller does not match the selected CPU',
        'Use the instance belonging to the selected offline CPU; no program was overwritten.',
        { expected: cpu, actual: status.controller },
      );
    if (run && status.state !== 'Run')
      fail(
        'SIMULATION_NOT_RUNNING',
        'The simulation must be in RUN for a pulse or behavioral verification',
        'Run the owned simulation explicitly, then retry.',
        { state: status.state },
      );
    return status;
  }
  async function writeItem(name, item) {
    const result = await invoke('tia_sim_write', {
      name,
      tag: item.tag,
      type: item.type,
      value: item.value,
    });
    const actual = typedRead(result, item);
    return {
      tag: item.tag,
      type: item.type,
      requested: item.value,
      actual,
      readbackMatches: equalValue(item.type, actual, item.value),
      status: 'written',
    };
  }
  async function nativeBatch(name, items, write) {
    let batch;
    try {
      batch = await invoke('tia_sim_batch', {
        name,
        items: items.map((item) => ({
          tag: item.tag,
          type: item.type,
          write,
          ...(write ? { value: item.value } : {}),
        })),
      });
    } catch (error) {
      return {
        success: false,
        values: [],
        failedIndex: null,
        skipped: null,
        executionConfirmed: false,
        writeMayHaveOccurred: write,
        error: errorInfo(error),
      };
    }
    const values = [];
    let failedIndex = null,
      error;
    const malformed = (message) => ({
      code: 'SIMULATION_BATCH_RESPONSE_INVALID',
      message,
      details: { response: batch },
    });
    if (
      batch?.instance !== name ||
      typeof batch?.success !== 'boolean' ||
      !Array.isArray(batch.results) ||
      batch.results.length > items.length
    ) {
      return {
        success: false,
        values,
        failedIndex: null,
        skipped: null,
        executionConfirmed: false,
        writeMayHaveOccurred: write,
        error: malformed(
          'The batch tool did not return a valid execution report; no operation was retried.',
        ),
      };
    }
    for (let index = 0; index < batch.results.length; index++) {
      const row = batch.results[index],
        item = items[index];
      if (
        row?.index !== index ||
        row.tag !== item.tag ||
        row.type !== item.type ||
        row.write !== write ||
        (write && row.success === true && row.writeCompleted !== true)
      ) {
        error = malformed('The batch result does not match the requested item at index ' + index);
        failedIndex = index;
        break;
      }
      if (row.success !== true) {
        failedIndex = index;
        error = errorInfo(
          typeof row.error === 'object'
            ? row.error
            : new Error(row.error || batch.error || 'Batch item failed'),
        );
        if (write)
          values.push({
            tag: item.tag,
            type: item.type,
            requested: item.value,
            status: 'failed',
            writeCompleted: row.writeCompleted === true,
            writeMayHaveOccurred: row.writeMayHaveApplied !== false,
            error,
          });
        break;
      }
      try {
        const value = typedRead(row, item);
        values.push(
          write
            ? {
                tag: item.tag,
                type: item.type,
                requested: item.value,
                actual: value,
                readbackMatches: equalValue(item.type, value, item.value),
                status: 'written',
                writeCompleted: row.writeCompleted === true,
              }
            : { tag: item.tag, type: item.type, value },
        );
      } catch (cause) {
        failedIndex = index;
        error = malformed('Invalid typed batch readback at index ' + index + ': ' + cause.message);
        break;
      }
    }
    if (!error && batch.success !== true) {
      failedIndex =
        Number.isInteger(batch.failedIndex) &&
        batch.failedIndex >= 0 &&
        batch.failedIndex < items.length
          ? batch.failedIndex
          : null;
      error = errorInfo(
        typeof batch.error === 'object'
          ? batch.error
          : new Error(batch.error || 'The batch operation failed'),
      );
    }
    if (!error && values.length !== items.length)
      error = malformed('The successful batch response did not include every requested item');
    const executionConfirmed = !error || error.code !== 'SIMULATION_BATCH_RESPONSE_INVALID';
    const meta = {
      ...(batch.stage ? { stage: batch.stage } : {}),
      completedCount: batch.completedCount,
      writesCompleted: batch.writesCompleted,
      remainingNotExecuted: batch.remainingNotExecuted,
    };
    return {
      success: batch.success === true && !error,
      values,
      failedIndex,
      skipped: executionConfirmed ? batch.remainingNotExecuted : null,
      executionConfirmed,
      batch: meta,
      ...(error ? { error } : {}),
      ...(write && !executionConfirmed ? { writeMayHaveOccurred: true } : {}),
      ...(batch.writeMayHaveApplied === false ? { writeMayHaveOccurred: false } : {}),
    };
  }
  async function readBatch(name, items) {
    const result = await nativeBatch(name, items, false);
    return {
      ...result,
      consistentSnapshot: false,
      ...(result.failedIndex === null ? {} : { failedTag: items[result.failedIndex].tag }),
    };
  }
  async function writeBatch(name, items, { continueOnError = false } = {}) {
    if (!items.length)
      return {
        success: true,
        atomic: false,
        values: [],
        failedIndex: null,
        skipped: 0,
        allReadbacksMatch: true,
      };
    if (!continueOnError) {
      const result = await nativeBatch(name, items, true);
      const allReadbacksMatch =
        result.values.length === items.length &&
        result.values.every((item) => item.status === 'written' && item.readbackMatches);
      const mismatch = result.success && !allReadbacksMatch;
      return {
        ...result,
        success: result.success && allReadbacksMatch,
        atomic: false,
        allReadbacksMatch,
        ...(mismatch
          ? {
              error: {
                code: 'SIMULATION_WRITE_READBACK_MISMATCH',
                message:
                  'The batch completed, but one or more readback values did not match the requested values',
              },
            }
          : {}),
      };
    }
    // Cleanup deliberately attempts each release even if another release fails.
    const values = [];
    let failedIndex = null;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      try {
        values.push(await writeItem(name, item));
      } catch (error) {
        if (failedIndex === null) failedIndex = index;
        values.push({
          tag: item.tag,
          type: item.type,
          requested: item.value,
          status: 'failed',
          writeMayHaveOccurred: true,
          error: errorInfo(error),
        });
      }
    }
    return {
      success: failedIndex === null,
      atomic: false,
      values,
      failedIndex,
      skipped: items.length - values.length,
      allReadbacksMatch: values.every((item) => item.status === 'written' && item.readbackMatches),
    };
  }
  return {
    prepareAndDownload(args) {
      return serial(async () => {
        const {
          name,
          cpu,
          cpuType = 'CPU1511',
          communication,
          createIfMissing = false,
          startAfter = false,
          selection = {},
        } = args;
        validateName(name);
        validateCpu(cpu, true);
        if (!CPU_TYPES.has(cpuType)) throw new TypeError('Unsupported simulated CPU type');
        if (communication !== undefined && !['Softbus', 'TCPIP'].includes(communication))
          throw new TypeError('communication must be Softbus or TCPIP');
        if (typeof createIfMissing !== 'boolean' || typeof startAfter !== 'boolean')
          throw new TypeError('createIfMissing and startAfter must be boolean');
        const report = { name, cpu, created: false, poweredOn: false, stage: 'inspect' };
        try {
          const instances = await invoke('tia_sim_list', {});
          const exists = instances.some((item) => item.name === name);
          if (exists) {
            report.before = await inspect(name, cpu, { program: false, allowOff: true });
            if (communication !== undefined && communication !== report.before.communication)
              fail(
                'SIMULATION_CHANNEL_MISMATCH',
                'The existing instance uses a different communication channel',
                'Use its current channel, or create a different instance. Existing instances are never silently reconfigured.',
                { requested: communication, actual: report.before.communication },
              );
          } else if (!createIfMissing)
            fail(
              'SIMULATION_NOT_FOUND',
              'The requested local simulation does not exist',
              'Create a new owned instance, or set createIfMissing:true.',
            );
          report.stage = 'compile_save';
          report.compileSave = await invoke('tia_compile_save', { cpu });
          if (report.compileSave?.success !== true)
            fail(
              'COMPILE_SAVE_FAILED',
              'Compilation or saving failed; the program was not downloaded',
              'Resolve the returned compiler errors and save the project before retrying.',
            );
          if (!exists) {
            report.stage = 'create';
            report.creation = await invoke('tia_sim_create', {
              name,
              cpuType,
              communication: communication ?? 'Softbus',
            });
            report.created = true;
          }
          let status = await inspect(name, cpu, { program: false, allowOff: true });
          if (status.state === 'Off') {
            report.stage = 'power_on';
            try {
              await invoke('tia_sim_control', { name, action: 'power_on' });
              report.poweredOn = true;
            } catch (error) {
              if (/VirtualSwitchMisconfigured|(?:Error Code:\s*)-50\b/.test(error.message || ''))
                fail(
                  'VIRTUAL_SWITCH_CONFIGURATION',
                  'PLCSIM could not start because its virtual switch configuration is inconsistent',
                  'Create a new Softbus instance for local-only simulation, or ask an administrator to review the Siemens virtual switch. No network adapters or bindings were changed.',
                  { cause: errorInfo(error) },
                );
              throw error;
            }
            status = await inspect(name, cpu, { program: false });
          }
          report.ready = status;
          report.stage = 'interfaces';
          const interfaces = await invoke('tia_list_interfaces', { cpu });
          report.route = selectSimulationRoute({ interfaces, status, cpu, config, selection });
          report.stage = 'download';
          report.download = await invoke('tia_sim_download', { ...report.route, name, startAfter });
          if (report.download?.success !== true)
            fail(
              'SIMULATION_DOWNLOAD_FAILED',
              'TIA did not report a successful simulation download',
              'Inspect the download result before retrying; the target may have been partially updated.',
            );
          report.stage = 'verify';
          let after = await inspect(name, cpu);
          if (startAfter && after.state !== 'Run') {
            await invoke('tia_sim_control', { name, action: 'run' });
            after = await inspect(name, cpu, { run: true });
          }
          return {
            ...report,
            stage: 'complete',
            success: true,
            communication: after.communication,
            after,
          };
        } catch (error) {
          if (error instanceof SimulationWorkflowError) {
            error.details = { ...error.details, workflow: report };
            throw error;
          }
          throw new SimulationWorkflowError(
            'SIMULATION_WORKFLOW_FAILED',
            error.message || String(error),
            'Inspect the returned completed stages before retrying; no instance was automatically removed or reconfigured.',
            { workflow: report, cause: errorInfo(error) },
          );
        }
      });
    },
    readMany({ name, cpu, tags }) {
      return serial(async () => {
        validateName(name);
        validateCpu(cpu);
        const items = validateBatch(tags);
        const target = await inspect(name, cpu);
        return { instance: name, controller: target.controller, ...(await readBatch(name, items)) };
      });
    },
    writeMany({ name, cpu, values }) {
      return serial(async () => {
        validateName(name);
        validateCpu(cpu);
        const items = validateBatch(values, true);
        const target = await inspect(name, cpu);
        return {
          instance: name,
          controller: target.controller,
          ...(await writeBatch(name, items)),
        };
      });
    },
    pulseBool({ name, cpu, tag, durationMs = 200, activeValue = true, releaseValue = false }) {
      return serial(async () => {
        validateName(name);
        validateCpu(cpu);
        validateTag({ tag, type: 'Bool' });
        validateSimulationValue('Bool', activeValue);
        validateSimulationValue('Bool', releaseValue);
        nonnegativeMs(durationMs, simulationLimits.pulseMs, 'Pulse duration');
        if (durationMs === 0) throw new RangeError('Pulse duration must be greater than zero');
        if (activeValue === releaseValue)
          throw new TypeError('Pulse active and release values must differ');
        const target = await inspect(name, cpu, { run: true });
        const result = {
          instance: name,
          controller: target.controller,
          tag,
          durationMs,
          activeValue,
          releaseValue,
          startedAt: new Date().toISOString(),
        };
        try {
          result.activation = await writeItem(name, { tag, type: 'Bool', value: activeValue });
          await sleep(durationMs);
        } catch (error) {
          result.error = errorInfo(error);
        } finally {
          // A write can fail after modifying the input, so always attempt release.
          try {
            result.release = await writeItem(name, { tag, type: 'Bool', value: releaseValue });
          } catch (error) {
            result.releaseError = errorInfo(error);
          }
        }
        result.releaseConfirmed = result.release?.readbackMatches === true;
        return {
          ...result,
          success:
            !result.error &&
            !result.releaseError &&
            result.activation?.readbackMatches === true &&
            result.releaseConfirmed,
          finishedAt: new Date().toISOString(),
        };
      });
    },
    verifyScenario(args) {
      return serial(async () => {
        const { name, cpu } = args;
        validateName(name);
        validateCpu(cpu);
        const scenario = validateScenario(args);
        const result = {
          name,
          cpu,
          success: false,
          startedAt: new Date().toISOString(),
          steps: [],
          failedStep: null,
          skippedSteps: scenario.steps.length,
          cleanup: {
            requested: scenario.cleanup.length,
            attempted: false,
            success: scenario.cleanup.length === 0,
          },
        };
        let verifiedCpu;
        try {
          const target = await inspect(name, cpu, { run: true });
          verifiedCpu = target.controller;
          result.controller = verifiedCpu;
          for (let index = 0; index < scenario.steps.length; index++) {
            const step = scenario.steps[index];
            const row = { index, label: step.label, success: false, writes: [], expectations: [] };
            result.steps.push(row);
            result.failedStep = { index, label: step.label };
            await inspect(name, verifiedCpu, { run: true });
            const written = await writeBatch(name, step.writes);
            row.writes = written.values;
            if (!written.success) {
              row.error = written.error ||
                written.values.find((item) => item.status === 'failed')?.error || {
                  code: 'SIMULATION_WRITE_FAILED',
                  message: 'The scenario inputs could not be confirmed',
                };
              result.error = row.error;
              break;
            }
            await sleep(step.waitMs);
            const readings = await readBatch(name, step.expect);
            for (let readIndex = 0; readIndex < readings.values.length; readIndex++) {
              const item = step.expect[readIndex],
                actual = readings.values[readIndex];
              row.expectations.push({
                tag: item.tag,
                type: item.type,
                expected: item.value,
                actual: actual.value,
                ...(item.tolerance === undefined ? {} : { tolerance: item.tolerance }),
                matched: equalValue(item.type, actual.value, item.value, item.tolerance),
              });
            }
            if (!readings.success) {
              row.error = readings.error;
              result.error = row.error;
              break;
            }
            row.success = row.expectations.every((item) => item.matched);
            if (!row.success) {
              row.error = {
                code: 'SIMULATION_EXPECTATION_FAILED',
                message: 'One or more actual PLC values did not match the expected values',
              };
              result.error = row.error;
              break;
            }
            result.failedStep = null;
          }
        } catch (error) {
          result.error = errorInfo(error);
          const row = result.steps.at(-1);
          if (row && !row.success) row.error = result.error;
        } finally {
          result.skippedSteps = scenario.steps.length - result.steps.length;
          if (scenario.cleanup.length) {
            if (!verifiedCpu)
              result.cleanup = {
                ...result.cleanup,
                success: false,
                skippedReason:
                  'The target identity/ownership was not verified; no cleanup writes were attempted.',
              };
            else {
              try {
                await inspect(name, verifiedCpu);
                result.cleanup.attempted = true;
                const cleaned = await writeBatch(name, scenario.cleanup, { continueOnError: true });
                result.cleanup = {
                  ...result.cleanup,
                  ...cleaned,
                  success: cleaned.success && cleaned.allReadbacksMatch,
                };
              } catch (error) {
                result.cleanup = { ...result.cleanup, success: false, error: errorInfo(error) };
              }
            }
          } else result.cleanup.skippedReason = 'No cleanup writes were supplied.';
        }
        result.success =
          !result.error &&
          result.steps.length === scenario.steps.length &&
          result.steps.every((step) => step.success) &&
          result.cleanup.success;
        result.finishedAt = new Date().toISOString();
        return result;
      });
    },
  };
}
