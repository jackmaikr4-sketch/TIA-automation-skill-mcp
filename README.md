# TIA Automation Skill MCP

**用 AI Agent 完成 TIA 博途编程与仿真。**

通过本地 MCP，让 AI 创建或修改 PLC 程序、编译保存，并在 PLCSIM Advanced 中运行和验证。支持 LAD/SCL、变量读写，以及启动、停止、点动操作面板。

当前主要支持 **Windows + TIA Portal V18 + 单 CPU S7-1500 + PLCSIM Advanced**。不需要单独填写 MCP API Key；AI 客户端本身的账号或费用由对应客户端管理。

## 安装前准备

- 安装 **Node.js 22+**。
- 安装并授权 **TIA Portal V18 / STEP 7、TIA Openness、PLCSIM Advanced**。原开发环境使用 PLCSIM Advanced API 4.1，其他版本需自行验证。
- 当前 Windows 用户加入 **Siemens TIA Openness** 用户组，然后注销并重新登录。
- 使用支持本地 stdio MCP 的 AI 客户端，例如 Codex。

本仓库不包含西门子安装包、许可证或 DLL。

## 1. 下载并配置

在 PowerShell 中运行：

```powershell
git clone https://github.com/jackmaikr4-sketch/TIA-automation-skill-mcp.git
cd TIA-automation-skill-mcp
npm.cmd ci
npm.cmd run configure
```

也可通过 GitHub 的 **Code → Download ZIP** 下载解压。

打开生成的 `config.json`，修改：

| 配置项 | 怎么填 |
| --- | --- |
| `tiaApiDirectory` | 包含 `Siemens.Engineering.dll` 的 V18 Openness 目录 |
| `simulationApiDirectory` | 包含 `Siemens.Simatic.Simulation.Runtime.Api.x64.dll` 的目录 |
| `allowedRoots` | 允许访问的工程目录；默认是本仓库的 `projects` |

路径使用 `/` 或双反斜杠 `\\`。保持 `physicalTargets: []`，默认只做本机仿真。`snap7Library` 为实体设备可选接口预留，本机仿真不需要下载 Snap7。

## 2. 安装并连接 Codex

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Register
```

脚本安装依赖、编译本地 C# 工作进程、运行测试，并注册 `tia-mcp`。编译需要 Windows 的 **.NET Framework 4.8** 及上述两个 Siemens API。自动注册要求 `codex` 命令可用；已有同名 MCP 条目会更新，配置会先备份。

完成后重新加载 MCP 或重启 Codex。首次连接时，在 Siemens 弹出的 Openness 授权窗口中核对并允许本仓库 `bin` 下的工作进程。

没有 `codex` 命令或使用其他客户端时，去掉 `-Register`，再参考 [客户端配置](docs/CONFIGURATION.md) 手动添加。

## 3. 直接告诉 AI 要做什么

可以复制这段话：

> 使用 tia-mcp，新建一个 S7-1500 学习工程，实现电机启动自保持、停止和点动。先检查已安装的 CPU 型号与固件，再编程、编译保存，在本机 PLCSIM Advanced 中运行，用实际变量读回验证功能，最后打开操作面板。不要下载到实体 PLC。

已有工程可以这样说：

> 使用 tia-mcp，连接我已打开的博途工程，读取 CPU、程序块和变量。先备份，再按我的要求修改程序，编译成功后保存，并在本机仿真中验证。

默认使用 **Softbus**，不必配置物理网卡。仿真过程中保持 MCP 连接或操作面板打开，不要同时用多个面板控制同一实例。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 找不到 Siemens DLL | 修改 `config.json` 中的两个 API 目录后重新安装 |
| Openness 权限不足 | 用管理员 PowerShell 运行 `scripts/enable-openness.ps1`，然后保存工作并注销、重新登录 |
| 工程不在允许目录 | 复制整个工程文件夹到 `projects`，或把目录加入 `allowedRoots` 后重启 MCP |
| 工程已有未保存修改 | 先在博途中明确保存，再让 AI 修改 |
| 修改代码后工具没更新 | 运行 `npm.cmd run build` 后重启 MCP |
| 无法启动仿真 | 检查 PLCSIM Advanced 安装与许可，运行 `npm.cmd run doctor` 查看诊断 |

## 支持范围

- 已有实现：LAD/SCL、程序块与变量管理、备份、编译保存、S7-1500 本机仿真、变量验证、操作面板。
- 暂不支持完整流程：S7-1200 标准 PLCSIM、WinCC/HMI、Startdrive、多个 PLC 协同仿真。
- 实体 PLC 操作未经过硬件验证，默认关闭。学习用仿真工程不能直接作为生产设备配置。

`npm.cmd test` 检查程序逻辑与 MCP 通信，不要求安装 Siemens 软件；`npm.cmd run test:integration` 还会运行真实 Siemens API 诊断，需要先编译工作进程。测试通过不等于实际 PLC 程序已验证，仿真功能应以变量读回为准。

详细使用流程见 [使用指南](docs/USAGE.md)。项目采用 [MIT 许可证](LICENSE)，第三方依赖见 [THIRD_PARTY.md](THIRD_PARTY.md)。
