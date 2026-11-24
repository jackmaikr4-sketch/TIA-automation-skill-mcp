import { validateMotorPanelConfig, canonicalTag } from './launch.mjs';

export const PANEL_ACTIONS = Object.freeze([
  'start',
  'stop',
  'jog_on',
  'jog_off',
  'overload_on',
  'overload_off',
  'shutdown',
  'detach',
]);
const writable = new Set(['start', 'stopOk', 'jog', 'overloadOk']);
export class MotorPanelController {
  constructor(
    config,
    { invoke, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {},
  ) {
    this.config = validateMotorPanelConfig(config);
    this.invoke = invoke;
    this.sleep = sleep;
    this.now = now;
    this.cpu = 'Unknown';
    this.jogDeadline = 0;
    this.interacted = false;
    this.message = '正在连接本机仿真…';
  }
  async identity() {
    const state = await this.invoke('tia_sim_control', {
      name: this.config.name,
      action: 'status',
    });
    if (state.controller !== this.config.cpu) throw Error('仿真目标与本面板不一致，已停止操作');
    this.cpu = state.state;
    return state;
  }
  async initialize() {
    const listed = await this.invoke('tia_sim_list', {});
    if (!listed.some((x) => x.name === this.config.name))
      throw Error('仿真实例不存在，请先通过 MCP 下载并运行工程');
    const state = await this.identity();
    if (state.state !== 'Run') throw Error('虚拟 PLC 尚未运行，请先通过 MCP 切换到 RUN');
    const tags = await this.invoke('tia_sim_tags', { name: this.config.name });
    for (const symbol of Object.values(this.config.tags))
      if (
        tags.filter((t) => canonicalTag(t.name) === canonicalTag(symbol) && t.type === 'Bool')
          .length !== 1
      )
        throw Error('输入输出变量缺失或不是 Bool 类型：' + symbol);
    this.message = '准备就绪：点击启动，或按住点动';
    return this.snapshot();
  }
  async read(role) {
    return (
      await this.invoke('tia_sim_read', {
        name: this.config.name,
        tag: this.config.tags[role],
        type: 'Bool',
      })
    ).value;
  }
  async write(role, value) {
    if (!writable.has(role) || typeof value !== 'boolean')
      throw Error('面板只允许写入四个布尔输入');
    return this.invoke('tia_sim_write', {
      name: this.config.name,
      tag: this.config.tags[role],
      type: 'Bool',
      value,
    });
  }
  async release() {
    this.jogDeadline = 0;
    try {
      await this.write('start', false);
    } finally {
      await this.write('jog', false);
    }
  }
  async stop() {
    await this.release();
    try {
      await this.write('stopOk', false);
      await this.sleep(200);
    } finally {
      await this.write('stopOk', true);
    }
    await this.sleep(100);
    if ((await this.read('motor')) || (await this.read('latch')))
      throw Error('尚未确认电机停止，请重试停止');
  }
  async snapshot() {
    await this.identity();
    const values = {};
    for (const role of Object.keys(this.config.tags)) values[role] = await this.read(role);
    return {
      connected: true,
      cpu: this.cpu,
      motor: values.motor,
      latch: values.latch,
      inputs: {
        start: values.start,
        stopOK: values.stopOk,
        jog: values.jog,
        frOK: values.overloadOk,
      },
      message: this.message,
      closed: false,
    };
  }
  async execute(action) {
    if (!PANEL_ACTIONS.includes(action)) throw Error('未知面板操作');
    if (action === 'detach')
      return { closed: true, connected: false, message: '面板已关闭，未修改仿真输入' };
    await this.identity();
    this.interacted = true;
    if (action === 'shutdown') {
      await this.stop();
      this.message = '电机已停止，面板已关闭';
      return { ...(await this.snapshot()), closed: true };
    }
    if (action === 'stop') {
      await this.stop();
      this.message = '已停止电机';
    } else if (action === 'jog_off') {
      this.jogDeadline = 0;
      await this.write('jog', false);
      this.message = '点动已释放';
    } else if (action === 'overload_on') {
      await this.release();
      await this.write('overloadOk', false);
      this.message = '已模拟过载，电机禁止运行';
    } else if (action === 'overload_off') {
      await this.release();
      await this.write('overloadOk', true);
      this.message = '过载已复位，请重新按启动';
    } else {
      if (this.cpu !== 'Run') throw Error('虚拟 PLC 未处于 RUN');
      if (!(await this.read('overloadOk')) || !(await this.read('stopOk')))
        throw Error('停止或过载信号有效，请先恢复正常');
      if (action === 'start') {
        try {
          await this.write('start', true);
          await this.sleep(200);
        } finally {
          await this.write('start', false);
        }
        this.message = '已按下并释放启动按钮';
      } else {
        this.jogDeadline = this.now() + 30000;
        await this.write('jog', true);
        this.message = '点动中：松开按钮即可停止';
      }
    }
    return this.snapshot();
  }
  async tick() {
    if (this.jogDeadline && this.now() >= this.jogDeadline) {
      await this.identity();
      this.jogDeadline = 0;
      await this.write('jog', false);
      this.message = '点动已释放（单次最长 30 秒）';
    }
    return this.snapshot();
  }
}

// A stop/fault/close barrier invalidates older starts, while preserving explicit
// fault/recovery/release requests and commands deliberately sent after the barrier.
export function applyStopBarrier(pending) {
  let at = -1;
  for (let i = 0; i < pending.length; i++)
    if (['stop', 'shutdown', 'overload_on'].includes(pending[i].action)) at = i;
  const discarded = [],
    kept = [];
  for (let i = 0; i < pending.length; i++)
    (i < at && ['start', 'jog_on'].includes(pending[i].action) ? discarded : kept).push(pending[i]);
  return { discarded, pending: kept };
}
