# 使用流程

1. 调用 `tia_capabilities` 查看当前支持能力。
2. 用 `tia_list_instances` 列出博途进程，再用 `tia_connect` 连接明确的进程；切换前调用 `tia_disconnect`。
3. 读取工程、CPU、程序块和变量。默认只允许仓库 `projects` 下的工程；可以配置 `allowedRoots`，或对用户指定且当前打开的确切工程使用 `tia_authorize_attached_project`。
4. 先备份，再创建或修改 LAD/SCL。替换已有块需先导出，携带对应 SHA256；过期内容会拒绝覆盖。已有未保存修改需要先保存。
5. 用 `tia_compile_save` 编译硬件和软件；两者无错误才保存，查看完整错误、警告及报告。
6. 用 `tia_sim_prepare_download` 准备本机受管理的 PLCSIM Advanced 实例并下载，按参数进入 RUN。下载接口来自实际枚举，不猜 IP 或回退到实体设备。
7. 用 `tia_sim_read_many`、`tia_sim_write_many`、`tia_sim_pulse`、`tia_sim_verify` 验证实际变量。批量读写不是原子操作，不能认为所有值来自同一扫描周期。
8. 需要手动体验时使用 `tia_sim_open_motor_panel`；查看程序使用 `tia_show_block`，查看 CPU 使用 `tia_show_device`。

AI 可通过 MCP 自动读取工具参数定义，不需要记住全部工具。运行 `node scripts/export-tools.mjs` 可导出当前工具清单到 `artifacts/tool-manifest.json`。

## 仿真与面板

主要面向单 CPU S7-1500；新建实例默认 Softbus。只修改 MCP 登记且名称以 `CodexMCP_` 开头的实例。仿真时保持连接，不要每次读写后关闭工作进程。

电机面板需要六个不同的 Bool 符号：启动、停止正常、点动、过载正常、电机输出、自保持状态。停止与过载采用常闭语义，正常为 true、动作时 false。面板打开时只读状态，不自动启动电机；指示灯来自实际变量读回。

## 文件和备份

- `projects`：用户工程，复制时需要整个工程目录，不能只复制 `.ap18`。
- `artifacts/backups`：修改前 `.zap18` 检查点；部分学习工程凭据使用当前 Windows 用户 DPAPI 加密。
- `artifacts`：编译报告、审计日志、面板状态等本地运行记录。
- `bin`：本机编译的工作进程，通过 `current.json` 选择版本。

这些运行文件和本机配置均不提交到 GitHub。请勿把含私人路径、凭据或用户工程信息的完整日志直接上传。

## 验证范围

原开发记录主要覆盖 TIA V18、CPU 1511-1 PN 固件 V2.9 与本机 PLCSIM Advanced。其他型号和版本需实际验证。仓库自动测试覆盖逻辑、输入校验和 MCP 协议，不能代替真实工程的编译、下载和变量读回验收。
