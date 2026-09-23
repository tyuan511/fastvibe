---
name: fastvibe-setup
description: 帮用户配置 FastVibe 客户端自身的功能——远程访问、内网穿透（frp 自建服务器 / cloudflared / ngrok）、MCP 服务器、界面与对话设置。用户说「帮我配置远程访问 / 用我的服务器穿透出去 / 装 frps / 加一个 MCP」之类时使用。
---

# 配置 FastVibe 自身

你运行在 FastVibe 桌面客户端里。`fastvibe_config_get` / `fastvibe_config_apply` 调用的是设置页本身用的同一批方法：你写进去的值会立刻出现在用户打开的设置页上，和用户自己点的一样。需要动另一台机器（比如用户的 VPS）时，用你平常的 `bash` + `ssh`。

## 通用流程

1. **先看现状**：`fastvibe_config_get({ action: "overview" })`。返回里的 `actions` 是完整的动作目录（每个动作的读/写类型和 input 字段），其余是当前状态。不要凭记忆猜字段。
2. **说清楚要做什么，再动手**：列出要改的东西（服务器上装什么、开哪些端口、客户端里填哪些表单），缺的信息一次问齐。
3. **做外部那一半**（服务器、本机命令行工具），每一步都验证。
4. **填表单**：`fastvibe_config_apply`。每次写入用户都会看到确认面板。
5. **验证并交付**：读回状态，确认真的通了，把结果（URL、下一步）告诉用户。

### 硬规则

- **远程访问密码绝不经过对话。** 调 `remote.set_password`（input 为空），由用户在弹出的输入框里填。不要让用户把密码发给你，也不要自己编一个。
- **不改权限。** `permissionMode` 等权限设置被拒绝是有意的；需要时请用户自己在 composer 里切换。
- **供应商 API Key 不走这里。** 让用户去 设置 → 供应商 自己粘贴。
- 一个动作失败时，把 `error` 原文和你的判断告诉用户，不要换个参数反复重试同一件事。
- **端口不通（安全组 / 防火墙）时停下来，请用户处理，不要绕过。** 云厂商的安全组只有用户能在控制台改；你能做的是把要放行什么说清楚，然后等用户说改好了再验证。**不要**为了「先跑通」擅自：改用恰好开着的端口（80、443、22……）、用 `ssh -R` / SSH 隧道代替 frp、换成 cloudflared / ngrok、关掉服务器上的整个防火墙。这些都会让用户得到一套和他以为的不一样、日后出问题也查不明白的配置。确实想换方案，先说明原因并征得用户同意。

---

## 远程访问：用户自己的服务器 + frp

目标：手机/别的电脑通过用户的 VPS 访问这台机器上的 FastVibe。链路是 `浏览器 → VPS 上的 frps → 本机 frpc → 127.0.0.1:<远程访问端口>`。

### 0. 先问清楚（一次问完）

- **服务器怎么登录**：先看 overview 里的 `sshHosts`，里面有就直接用它的 `host`（ssh 别名）。没有就问地址、用户名、端口。
- **有没有域名**：
  - 有域名，且 A 记录已指向这台服务器 → 用 `http` 模式（可以再加 HTTPS，见第 6 步）。
  - 没有域名 → 用 `tcp` 模式，URL 是 `http://<服务器IP>:<remotePort>`。
- **服务器上是否已经有 frps**：有的话复用，不要覆盖别人的配置。

提醒用户一句：`http://` 明文访问时，登录密码会以明文经过公网。有域名时推荐加 HTTPS。

### 1. 确认能免交互登录

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 <host> 'uname -m; . /etc/os-release && echo "$PRETTY_NAME"; id -u; command -v systemctl; sudo -n true && echo SUDO_OK'
```

- `Permission denied`：只能用密码登录。FastVibe 里保存的 SSH 密码你拿不到，也不该拿。请用户自己运行一次 `ssh-copy-id <user>@<host>`（或给你一个 key 路径），然后再继续。
- 不是 root 且没有 `SUDO_OK`：需要 sudo 的命令让用户自己在服务器上执行，你把完整命令给他们。
- 没有 systemd：用 `nohup` 起进程也行，但要告诉用户重启后不会自动运行。

### 2. 看有没有现成的 frps

```bash
ssh <host> 'systemctl is-active frps 2>/dev/null; ls /etc/frp 2>/dev/null; command -v frps && frps --version; ss -ltnp 2>/dev/null | grep -E ":(7000|80|443|8080)\b"'
```

已经有 frps：读它的配置（`bindPort`、`auth.token`、`vhostHTTPPort`），问用户是否复用。复用就跳到第 4 步。

### 3. 安装 frps（需要 ≥ 0.52，因为用的是 TOML 配置）

架构映射：`x86_64 → amd64`，`aarch64 → arm64`。

```bash
ssh <host> 'set -e
VER=$(curl -fsSL https://api.github.com/repos/fatedier/frp/releases/latest | sed -n "s/.*\"tag_name\": *\"v\([^\"]*\)\".*/\1/p")
ARCH=amd64   # 按 uname -m 改
cd /tmp && curl -fsSLO https://github.com/fatedier/frp/releases/download/v$VER/frp_${VER}_linux_$ARCH.tar.gz
tar xzf frp_${VER}_linux_$ARCH.tar.gz
sudo install -m 755 frp_${VER}_linux_$ARCH/frps /usr/local/bin/frps
frps --version'
```

服务器下不了 GitHub（常见于国内机房）：在本机下载同一个 tar 包，`scp` 上去再装。

生成 token 并写配置（token 在服务器上生成）：

```bash
ssh <host> 'set -e
sudo mkdir -p /etc/frp
TOKEN=$(openssl rand -hex 16)
sudo tee /etc/frp/frps.toml >/dev/null <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "$TOKEN"
# http 模式才需要；80 已被 nginx/caddy 占用或要加 HTTPS 时用 8080
vhostHTTPPort = 8080
EOF
sudo chmod 600 /etc/frp/frps.toml
sudo tee /etc/systemd/system/frps.service >/dev/null <<EOF
[Unit]
Description=frps
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now frps
sleep 1 && systemctl is-active frps && echo "TOKEN=$TOKEN"'
```

- `tcp` 模式：删掉 `vhostHTTPPort`，需要限制可用端口时加 `allowPorts = [{ start = 7001, end = 7100 }]`，并选一个 `remotePort`（如 7001）。
- 没有域名、80 端口空闲、也不打算加 HTTPS：`vhostHTTPPort = 80`，URL 就是 `http://<域名>`。

### 4. 开端口

服务器上的防火墙：

```bash
ssh <host> 'if command -v ufw >/dev/null && sudo ufw status | grep -q active; then sudo ufw allow 7000/tcp; sudo ufw allow 8080/tcp; fi
if command -v firewall-cmd >/dev/null && sudo firewall-cmd --state 2>/dev/null; then sudo firewall-cmd --permanent --add-port=7000/tcp --add-port=8080/tcp && sudo firewall-cmd --reload; fi'
```

（端口按实际：`bindPort`，加上 `vhostHTTPPort` 或 `remotePort`。）

然后**从本机**验证每个要对外的端口（`bindPort`，加上 `vhostHTTPPort` 或 `remotePort`；用第 6 步的 HTTPS 时是 80 和 443，而不是 8080）：

```bash
for p in 7000 8080; do nc -z -w5 <服务器地址> $p && echo "$p OPEN" || echo "$p BLOCKED"; done
```

有 `BLOCKED` 时先在服务器上确认 frps 真的在监听、而且不是只监听 127.0.0.1：

```bash
ssh <host> 'ss -ltn | grep -E ":(7000|8080)\b"'
```

在监听（`0.0.0.0:7000` 或 `*:7000`）但本机连不上 → **几乎一定是云厂商的安全组**。它不在服务器里，你改不了，也不要绕过（见硬规则）。**停下来**，这样告诉用户：

> 服务器上 frps 已经在运行，但从外面连不上 **TCP 7000、8080**，是云服务器的安全组没有放行。请到控制台添加入方向规则：
> - 位置：阿里云「ECS → 安全组 → 入方向」/ 腾讯云「CVM → 安全组 → 入站规则」/ AWS「EC2 → Security Groups → Inbound rules」/ 其他厂商在「安全组」或「防火墙」里
> - 协议 **TCP**，端口 **7000、8080**（按实际列出），来源 `0.0.0.0/0`（只从固定网络访问的话可以填那个网段）
>
> 改好后告诉我，我再检测一次。

用户说改好了再跑一遍上面的 `nc`。仍然 `BLOCKED`：核对用户放行的是不是这台实例绑定的安全组、端口和协议有没有填错，以及服务器防火墙（上面的 ufw / firewalld）有没有漏；**不要**这时改成别的端口或别的穿透方式。

应用内同样会提示：frpc 首次登录超时时，设置页会直接显示「安全组没有放行 TCP <端口>」。

### 5. 本机的 frpc 和表单

1. `fastvibe_config_get({ action: "remote.tunnel_tools" })`，看 `frp.installed`。没装：
   - macOS：`brew install frpc`
   - Linux：同第 3 步下载 tar 包，把 `frpc` 装进 PATH 上的目录
   - Windows：从 GitHub Release 下载 `frp_*_windows_amd64.zip`，把 `frpc.exe` 放进 PATH
   装完再查一次，确认 `installed: true` 且版本 ≥ 0.52。
2. 填表单：

   ```json
   { "action": "remote.frp_set", "input": {
     "serverAddr": "<服务器 IP 或域名>", "serverPort": 7000, "token": "<TOKEN>",
     "mode": "http", "domain": "fv.example.com", "vhostPort": 8080
   } }
   ```

   `tcp` 模式：`"mode": "tcp", "remotePort": 7001`，不填 `domain`。URL 是推导出来的（frpc 自己不报 URL）；前面有 HTTPS 反代时用 `publicUrl` 覆盖。
3. 没设过密码（`remote.status` 里 `configured: false`）：`remote.set_password`。
4. `remote.set_tunnel` → `{ "provider": "frp" }`。
5. 服务没在跑（`running: false`）：`remote.start`。只选隧道不会启动服务。

### 6.（可选，有域名时推荐）HTTPS

frps 让出 80/443（`vhostHTTPPort = 8080`），在服务器上用 Caddy 自动签证书：

```
fv.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

WebSocket 不需要额外配置。然后 `remote.frp_set` 补上 `"publicUrl": "https://fv.example.com"`，并关掉公网上的 8080（只让 Caddy 访问它）。

### 7. 验证并交付

每隔几秒 `remote.status` 一次（中间用 `bash` 的 `sleep 3`），直到 `tunnel.phase` 变成 `online` 或 `error`，最多一分钟。

- `online`：`curl -sI <tunnel.url>` 应该返回 200 或跳转。告诉用户 URL，并说明 设置 → 远程访问 里有同一个链接的二维码，手机扫码后用刚设的密码登录。
- `error`：看 `tunnel.error` 和 `tunnel.output` 的最后几行：

| frpc 输出 | 原因 | 处理 |
|---|---|---|
| `token in login doesn't match` / `authorization failed` | token 不一致 | 重读服务器上的 `auth.token`，`remote.frp_set` 只改 `token` |
| `i/o timeout`（连 7000），设置页提示「安全组没有放行」 | 安全组或服务器防火墙挡住了 | 第 4 步：请用户放行，**不要绕过** |
| `connection refused`（连 7000） | frps 没跑、`bindPort` 不一致，或防火墙拒绝 | 第 2 步 |
| `port already used` / `port not allowed` | `remotePort` 被占用或不在 `allowPorts` 里 | 和用户商量换一个端口（换了的话安全组也要放行新端口） |
| `proxy already exists` | 另一台机器在用同一个代理名 | 让用户确认；proxyName 由客户端生成，一般不会撞 |
| `online` 了，但手机打不开（超时） | `vhostHTTPPort` / `remotePort` 没在安全组放行 | 第 4 步，请用户放行这个端口 |
| 通了，但浏览器打开是 frps 的 404 页 | 域名不对或 DNS 没指到这台服务器 | `dig +short <domain>`，并核对 `domain` |
| 能打开页面，登录后「连接被断开」 | 反代没转发 WebSocket | 检查 Caddy/nginx 配置 |

---

## 其他穿透方式

- **cloudflared（最省事，无需服务器/账号）**：没装就 `brew install cloudflared`（其他平台见 Cloudflare 文档），然后 `remote.set_tunnel { provider: "cloudflared" }` + `remote.start`。URL 每次启动都会变，告诉用户这一点；要固定地址就用 frp。
- **ngrok**：需要账号的 authtoken。`remote.tunnel_tools` 里 `ngrok.authenticated === false` 时，请用户在自己的终端运行 `ngrok config add-authtoken <token>`（token 在 https://dashboard.ngrok.com/get-started/your-authtoken），然后再选 ngrok。

## MCP 服务器

用 `mcp.upsert` 一次加或改一个，不会影响其他服务器：

```json
{ "action": "mcp.upsert", "input": { "server": {
  "id": "github", "name": "GitHub", "transport": "stdio",
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<用户提供>" }
} } }
```

HTTP 型：`"transport": "http", "url": "https://…/mcp"`。写完用 `mcp.list` 看 `connected` 和 `error`；stdio 型连不上时，先在 bash 里直接跑一遍 `command args` 看报错。

## 界面与对话设置

`settings.get` 读当前值，`settings.set { patch: { … } }` 只写要改的键。权限、远程访问（`remote*`）、代理（`proxy*`）的键会被拒绝：远程访问用上面的 `remote.*` 动作，代理和权限请用户在界面里改。
