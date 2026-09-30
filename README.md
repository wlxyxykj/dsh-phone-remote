# dsh-phone-remote · 手机遥控

> 生成一个链接，用手机控制这台电脑上的 DSH Agent 干活：看会话、发指令、实时看输出、随时喊停。

DSH 自带的 Web 界面只监听 `127.0.0.1`（本机回环），手机永远打不开。这个插件自己起一个
**只服务手机**的轻量 HTTP 服务，给你一个带访问口令的链接和一个二维码：

- **手机端** `http://<局域网IP>:8790/m?t=<口令>` —— 移动端聊天界面：会话列表 / 新建会话 / 发指令 / 流式输出 / 停止。
- **电脑端** `http://127.0.0.1:8790/` —— 控制台：二维码、链接、口令、会话概览。**只在 127.0.0.1 提供**，手机上打不开，避免把管理面暴露出去。
- **Agent 工具** `phone_remote` —— 可以直接对 DSH 说"给我手机遥控的链接"，它会返回链接和面板地址。

```
┌──────────────┐   链接 + 二维码   ┌────────────┐   局域网 HTTP   ┌──────────────────┐
│ 手机浏览器    │ ◀─────────────── │ 电脑面板    │ ◀───────────── │ DSH 主机进程      │
│ /m?t=<token> │ ───────────────▶ │ 127.0.0.1  │                │ ctx.session      │
│ 聊天 / 停止   │   SSE 流式输出    │ :8790      │                │ Controller       │
└──────────────┘                  └────────────┘                └──────────────────┘
```

---

## 安装

```powershell
# 从 npm（发布之后）
dsh plugin add dsh-phone-remote

# 从本地目录 / 打好的 tarball
dsh plugin add "C:\path\to\dsh-phone-remote"
dsh plugin add "C:\path\to\dsh-phone-remote-1.2.2.tgz"

# 从 GitHub
dsh plugin add github:<user>/<repo>
```

也可以在 DSH 的「设置 → 插件」里选择本地 `.tgz` 或用包名安装。

> ### ⚠️ 安装/升级后需要重启一次 DSH Desktop
>
> DSH 宿主进程**按模块 URL 缓存插件代码**，进程存活期间不会重新读取磁盘上的插件模块
> （实测：改文件、改 `package.json`、禁用再启用都不生效，只有换一个从未加载过的模块路径才会重新加载）。
> 所以**升级插件代码后重启一次**即可；配置项改动可以热生效，不用重启。
>
> 重启后启动日志里会出现：
>
> ```
> [dsh-phone-remote]
>   ┌─ DSH 手机遥控已就绪 ─────────────────────────────────
>   │ 监听      0.0.0.0:8790
>   │ 电脑面板  http://127.0.0.1:8790/
>   │ 访问控制  开放（任何能连到本机的设备都可以，凭口令访问）
>   │ 手机打开：
>   │   http://192.168.x.x:8790/m?t=xxxxxxxx   WLAN
>   └──────────────────────────────────────────────────────
> ```

## 使用

1. 电脑浏览器打开 **http://127.0.0.1:8790/**。
2. 手机连 **同一个 Wi-Fi**，用相机扫面板上的二维码（或手输链接）。
3. 手机页面左上角 `☰` 选一个已有会话，或"＋ 新建会话并接管"，然后直接发指令。
4. 输出会流式推到手机上；运行中右下角按钮变成 **■**，点它就叫停当前回合。

> 链接里的口令就是全部凭证，等同于电脑的操作权限：别截图外发、别丢群里。
> 不要把这个端口映射到公网（端口转发 / 内网穿透）。

### 手机端显示规则

- **Markdown 会真的渲染**：`**加粗**`、`*斜体*`、`` `行内代码` ``、``` 代码块 ```、`# 标题`、列表、引用、分割线、链接。
  渲染走 `lib/markdown.js`（纯函数、无依赖），转 DOM 时只用 `textContent`，模型输出里的 HTML 一律当纯文本，不会被执行。
- **模型的思考过程（reasoning）不混进正文**：正文只取 `text` 块；思考内容单独放进一个默认折叠的
  💭「思考过程」块，点开才看。还在思考时只显示一行「💭 思考中…」，不刷屏。
- 工具调用是一行可展开的卡片（名称 + 参数摘要 + 状态），点开才看完整输出。

## 配置

写在 profile 的 `cordis.patch.yml` 里（放在 `- insert:` 之前，用 id 定向覆盖）：

```yaml
- id: phone-remote
  name: 'dsh-phone-remote'
  config:
    enabled: true            # false 完全关闭（不监听、不注册工具）
    host: '0.0.0.0'          # 改成 127.0.0.1 就只有本机能访问（手机用不了）
    port: 8790               # 被占用时自动往后找，最多试到 8799
    token: ''                # 留空 = 复用/自动生成，存 $DSH_HOME/dsh-phone-remote.json
    cwd: ''                  # 手机上新建会话时的默认工作目录
    agentPreset: ''          # 新建会话使用的 agent preset id
    approvalPolicy: 'never'  # 手机会话的授权策略：never | ask
    allowCreate: true        # 是否允许手机新建会话
    allowCancel: true        # 是否允许手机叫停
    exposePanel: true        # 是否提供 127.0.0.1 上的电脑面板
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时插件不监听、不注册工具，等同于关闭 |
| `host` | `0.0.0.0` | 监听地址，`0.0.0.0` 才能被手机访问 |
| `port` | `8790` | 起始端口，占用时向后顺延 |
| `token` | 空 | 访问口令；留空则复用状态文件里的，没有就生成 24 位随机口令 |
| `cwd` | 空 | 手机新建会话的默认目录；手机页面也可以临时输入 |
| `agentPreset` | 空 | 手机新建会话使用的 preset |
| `approvalPolicy` | `never` | `never` = 远程会话不再逐条询问授权；`ask` = 跟随桌面端应答（手机看不到弹窗，可能卡住） |
| `allowCreate` / `allowCancel` | `true` | 关掉后手机只能看和发指令 |
| `exposePanel` | `true` | 关掉后连本机的 `/` 面板也不再提供 |
| `allowFrom` | `[]` | IP 白名单。非空 = 只有名单里的客户端能用手机面，且面板不能再改；留空则在面板上管理 |

改完保存即生效（live profile 热加载）；`token` 改动后手机上要重新扫码。
`allowFrom` 之外的白名单改动不需要重启——面板上改完立即生效。

**重置口令**：面板上点"重置口令"，旧链接立即失效并写入状态文件。

## 手机连不上？

按顺序排查：

1. **同一个 Wi-Fi**：电脑和手机必须在同一个局域网。面板上会列出所有网卡地址，选名字是
   `WLAN` / `Wi-Fi` / `以太网` 的那一条（`VirtualBox`、`VMware`、`vEthernet` 之类的虚拟网卡手机连不上）。
2. **Windows 防火墙**：第一次监听入站端口时可能被拦。管理员 PowerShell 执行一次：

   ```powershell
   New-NetFirewallRule -DisplayName "DSH Mobile Remote" -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 8790 -Profile Private
   ```

   （端口改成实际端口；只想给专用网络放行就用 `-Profile Private`。）
3. **公共网络**：Windows 把 Wi-Fi 标成"公用网络"时，上面的 `-Profile Private` 规则不生效，
   需要在设置里把该网络改成"专用网络"，或把规则改成 `-Profile Any`（风险更高）。
4. **端口被占**：日志里会有实际监听端口，以日志/面板为准。
5. **手机浏览器**：直接用系统浏览器打开，微信内置浏览器可能限制 `EventSource`。

## 访问控制（只允许你的手机）

默认是**开放**的：任何能连到这台电脑的设备都能打开登录页（仍要口令）。如果电脑有公网 IP
（校园网/宽带直连很常见，实测外部节点能直接连上 8790 端口），建议在电脑面板启用「仅白名单」：

1. 打开 http://127.0.0.1:8790/ → 「访问控制」卡片。
2. 手机先访问一次链接（被拦也没关系），它的 IP 会出现在「最近访问的客户端」里，标记为「已拦截」。
3. 点那行的「允许」→ 该 IP 立即放行，**不需要重启**。

白名单每行支持三种写法：

| 写法 | 含义 |
| --- | --- |
| `203.0.113.42` | 只放行这一个地址 |
| `203.0.113.` | 放行 `203.0.113.*` 整个前缀 |
| `10.0.0.0/8` | CIDR 网段 |

注意：**手机用移动数据时 IP 会变**（开关飞行模式就会变）。变了之后手机会收到"此设备未授权"，
在面板的「最近访问」里点一下「允许」即可。嫌麻烦就用 Tailscale 组网，然后把白名单写成它的
固定网段 `100.64.0.0/10`，从此不用再维护。

也可以写死在配置里（此时面板不能编辑）：

```yaml
- id: phone-remote
  name: 'dsh-phone-remote'
  config:
    allowFrom: ['203.0.113.42', '10.0.0.0/8']
```

名单存在 `$DSH_HOME/dsh-phone-remote.json`（`allowEnabled` + `allowFrom`），重启后保持。

## 配合 Tailscale：固定地址 + 加密，彻底不暴露公网

手机用移动数据时 IP 会变，白名单要反复维护；而且现在是明文 HTTP。Tailscale 一次解决这两件事。

**原理**：它基于 WireGuard，把你的设备组成一个私有网络，每台设备拿到一个固定的
`100.x.y.z` 地址，设备之间端到端加密直连（打不通才走中继）。所以：不需要公网 IP、不需要端口转发、
IP 不会变、链路上抓不到明文口令。

**步骤**

1. 电脑装 Tailscale（[tailscale.com/download](https://tailscale.com/download) 或
   `winget install tailscale.tailscale`），用任意账号登录（Google/GitHub/Microsoft/邮箱都行）。
2. 手机装 Tailscale（App Store / Play Store），**登录同一个账号**，打开开关。
3. 电脑上执行 `tailscale ip -4`，拿到形如 `100.101.102.103` 的地址；面板上的链接列表里也会
   自动多出一条 Tailscale 地址（1.1.1 起排在第一位）。
4. 手机上打开 `http://100.101.102.103:8790/m?t=<口令>`，以后无论 Wi-Fi 还是流量都能用。

**收口（二选一）**

| 方案 | 做法 | 效果 |
| --- | --- | --- |
| A. 只换地址 | 保持 `host: '0.0.0.0'`，白名单写成 `100.64.0.0/10` | 公网仍能连到端口，但一律 403，只有你的 tailnet 能进 |
| B. 只监听 Tailscale 网卡 | 配置 `host: '100.101.102.103'` | 公网连 TCP 握手都做不到，最彻底 |

方案 B 的注意点：Tailscale 必须在 DSH 启动前已经连上，否则那个地址不存在。1.1.1 起插件遇到
这种情况会**自动退回监听 `0.0.0.0` 并打一条告警**，不会整个插件起不来（此时请确保白名单是开的）。

> 国内提示：`login.tailscale.com` 偶尔不好访问；连不上就换 **ZeroTier**，原理完全一样
> （插件同样会把它的网卡排在前面）。两者都免费供个人使用。

## 安全模型

| 面 | 谁能访问 | 保护 |
| --- | --- | --- |
| `/` 电脑面板、`/api/panel/*`、`/api/qr` | 仅 `127.0.0.1` | 非回环请求一律 404，手机拿不到口令 |
| `/m`、`/api/m/*` | 白名单内的设备（未启用白名单时=任何可路由到本机的设备） | IP 白名单（可选）+ 24 位随机口令（约 120 bit） |
| 口令比对 | — | SHA-256 + `timingSafeEqual` 常数时间比较 |
| 暴力破解 | — | 每 IP 每分钟最多 20 次失败，超出返回 429 |
| 被拒客户端 | — | 返回 403，并在面板「最近访问」里留痕，方便一键放行 |
| 浏览器侧 | — | 口令落在 `HttpOnly` + `SameSite=Strict` Cookie；成功后从地址栏抹掉 `?t=`，避免历史记录/截图泄漏 |
| 其他 | — | `nosniff`、`no-referrer`、CSP `default-src 'none'`；请求体上限 256 KB；不发送任何 CORS 放行头 |

手机端拿到口令后可以：列会话、新建会话、发指令（Agent 会真的执行命令、改文件）、叫停回合。
**所以口令 + 网络可达性等于电脑操作权**：建议启用白名单，公共 Wi-Fi 下用完就在配置里 `enabled: false`。
另外目前是明文 HTTP，链路中间人仍可能嗅探口令——要彻底解决就用 Tailscale 之类的加密隧道。

## 权限与授权

- 远程会话默认被设成 `approvalPolicy: never`，否则手机端看不到桌面端的授权弹窗，Agent 会卡在等待里。
- 该策略是"新建/接管会话时"通过 `ctx.approval.setPolicy(agent, 'never')` 写入会话日志的；`resolveAgent` 先恢复
  Agent 再写策略，保证**第一条指令**就不弹授权。
- 想保留逐条授权就把 `approvalPolicy` 改成 `ask`，此时请让桌面端也打开同一个会话，由桌面端点"允许"。

## 已知限制

- **`ask_user_question`**：Agent 主动提问时，回答者是客户端（桌面 GUI）。如果手机用的是桌面端没打开的会话，
  该问题会一直等到超时。插件没有代答。
- **图片/文件**：手机端目前只发纯文本，不支持上传附件。
- **多标签**：同一个口令可以在多台设备上同时打开，都会实时跟随同一个会话。

## 工作方式（实现要点）

- `lib/index.js` 插件入口：读配置、拿/生成口令、启动监听、注册 `phone_remote` 工具、注册卸载清理。
- `lib/server.js` 手机面 + 电脑面板的 HTTP 路由、口令校验、SSE 推送、端口顺延、优雅停止。
- `lib/session.js` 到 host 服务的桥接：`sessionController.list/create/resolveAgent/prompt/cancel/follow`
  （`prompt`/`follow` 必须传真实 `AbortSignal`，host 会直接 `signal.throwIfAborted()`）。
- `lib/app.html` 手机端页面（原生 JS，无依赖，SSE + 自动重连）。
- `lib/panel.html` 电脑端控制台（二维码 + 链接 + 状态）。
- `lib/qr.js` 零依赖 QR 编码器（字节模式，版本 1–10，EC L/M/Q/H，自动选版本与掩码）。
- `lib/store.js` / `lib/net.js` 状态持久化与局域网地址探测。

测试：

```powershell
node --test "test/*.test.mjs"     # 82 个测试：HTTP/鉴权/SSE、IP 白名单、Markdown/思考过程渲染、会话桥、插件装配、QR 编码
```

三层验证都做过：

1. **单元/集成测试 82 项全绿**（`test/server.test.mjs`、`test/session.test.mjs`、`test/plugin.test.mjs`、`test/qr.test.mjs`）。
   其中白名单不是只测函数：会真的绑到 `0.0.0.0`、从非回环地址发请求，验证「被拒 403 → 面板放行 → 同一条请求变 200」。
   另有 4 项是与两套独立 QR 实现（`node-qrcode`、`qrcode-generator`）的逐模块交叉比对，
   需要 `scratch/` 里的参考实现；克隆下来没有它时会自动跳过，其余 78 项照常通过。
2. **对着运行中的 DSH 桌面端做过一次真实端到端**：用手机同款 HTTP 调用 `create → prompt → stream`，
   Agent 真实跑了完整一轮（`turn/start … assistant/message … turn/end {completed}`），回复内容与指令一致。
3. **对安装后的产物做过一次"重启后"预演**：在 profile 目录里按包名 `import('dsh-phone-remote')`，
   挂载后验证面板、口令栅栏（401）、建会话、发指令（含 `approval setPolicy` 顺序）、SSE 帧、工具渲染与卸载停止。

QR 编码器用两套独立实现做过逐模块比对（`node-qrcode` 1.5.3、`qrcode-generator` 1.4.4）：
354 组符号，除 4 例"ISO 严格掩码选择"与参考实现的非 ISO 取整差异外逐位一致，并含自解码往返校验。

## License

MIT
