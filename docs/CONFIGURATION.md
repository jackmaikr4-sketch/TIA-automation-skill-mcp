# 客户端配置

先完成 README 中的配置和安装，再把下面条目合并到现有客户端配置。将示例中的 Node 路径和仓库路径替换为自己的绝对路径，不要覆盖整个配置文件。

## Codex

```toml
[mcp_servers.tia-mcp]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Tools\TIA-automation-skill-mcp\src\server.mjs']
startup_timeout_sec = 30
tool_timeout_sec = 240
```

## 通用 stdio MCP 配置

```json
{
  "mcpServers": {
    "tia-mcp": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Tools\\TIA-automation-skill-mcp\\src\\server.mjs"]
    }
  }
}
```

不同客户端的配置文件位置和外层格式可能不同，工具超时建议 240 秒。修改后重启连接。

配置默认读取仓库的 `config.json`，也可以设置环境变量 `TIA_MCP_CONFIG` 指向另一份配置的绝对路径。构建脚本和 MCP 使用同一份配置。

这是本机 stdio 服务，没有公开网络端口。只能连接远程 HTTP MCP 的网页或手机客户端不能直接使用以上配置。
