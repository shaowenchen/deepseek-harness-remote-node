# 设计方案：远程机器接入 dsh 执行世界（Remote Node Execution World）

- 状态：已实现（本文保留为设计依据；实现与本方案的偏差见文末「实现现状」）
- 日期：2026-09-11
- 目标版本：v1
- 前置决策：节点角色＝执行世界；网络＝公网 + TLS 反代；作用范围＝全局唯一节点

## 1. 目标与非目标

### 目标

让一台远程机器通过 dsh 对外的 Web 入口拨入，成为 dsh 的**执行世界**：agent 的文件操作、shell 命令、终端、语言服务器全部发生在那台机器上，而 agent 循环、模型调用、会话状态、插件状态仍留在中心。

### 非目标（v1 明确不做）

- 不做节点池与调度：全局唯一节点。
- 不做会话迁移：执行世界是进程级的，不随会话漂移。
- 不做"重连活句柄"：断线不恢复 pending 调用、回调、输出游标。
- 不把整个 harness 搬到远程：中心仍是唯一的 harness 宿主。
- 不通过浏览器会话鉴权节点：两套凭证体系，互不复用。

第 3、4 条不是保守，而是对齐仓库已有的架构决策，理由见 §3。

## 2. 为什么方案长这样：三个既有事实

这个设计不是我发明的形状，是仓库里已经存在的三个事实推导出来的。

### 2.1 事实一：执行世界接缝已经存在，且就是为这个场景留的

`packages/fs/fs` 与 `packages/subprocess/subprocess` 合起来定义**一个执行世界**：

```ts
// packages/subprocess/subprocess/src/index.ts
abstract resolveExecutable(...): ...
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

```ts
// packages/fs/fs/src/index.ts
abstract resolve(path, opts?): Promise<FsTarget>
abstract processPath(target: FsTarget): string
abstract stat(...) / lstat(...) / readText(...) / streamText(...) / editText(...) ...
```

架构决策记录把这个约束写死了：两个 provider **必须描述同一个路径命名空间、同一批可执行文件、同一个进程世界**，上层能力只消费这两个接口，**不点名 provider**。

这带来本方案最大的红利：**bash、PTY、LSP 不需要任何节点专属代码**。`dsh-bash-local` 继续把 bash 语义映射到 `ctx.subprocess.spawn()`；`dsh-terminal-bash` 映射到 `spawnTerminal()`；`dsh-lsp-stdio` 同时消费 `ctx.fs` 和 `ctx.subprocess`。换掉底下两个 provider，这三者原地生效。

### 2.2 事实二：E2B 是现成先例，形状可以直接照抄

`packages/e2b/` 就是"一个 owner + 两个适配器"：

| 包 | 角色 | ctx key |
|---|---|---|
| `dsh-e2b` | 一个共享的远程 Linux 沙箱，负责生命周期 | `ctx.e2b` |
| `dsh-fs-e2b` | 实现 `ctx.fs` | `ctx.fs` |
| `dsh-subprocess-e2b` | 实现 `ctx.subprocess` | `ctx.subprocess` |

两个适配器只从 owner 拿唯一的 SDK 句柄，**自己绝不创建第二个沙箱**。E2B 已经把 `ctx.fs`/`ctx.subprocess` 映射到一套第三方 SDK 上——这证明：**该做适配器的地方是适配器，不是传输层**。本方案就是把 E2B 的"第三方 SDK"换成"我们自己定义的节点协议"。

### 2.3 事实三：架构决策明确否决了两条路，方案必须正面绕过

`.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md` 的 Rejected 列表里：

> **Add a generic distributed-runtime abstraction or reconnect live handles.** Rejected because the existing capability seams carry the demonstrated contracts, while remote identity alone cannot reconstruct callbacks, pending promises, authority, protocol state, or output cursors.

> **Run the whole harness inside the remote environment.** Rejected as a different deployment model.

所以本方案：

- **不引入**通用分布式运行时抽象，只实现那两个已有接缝。
- **不做**活句柄重连（详见 §6 失败语义）。
- **不搬**harness。

顺着架构走，方案就小；逆着走，就会长出一个和现有接缝打架的新层。

## 3. 拓扑

```
                    ┌──────────────────────────────────────────┐
   浏览器 ──HTTPS──▶│  nginx / caddy （TLS 终结，唯一的公网面） │
   (已有)           └───────────────┬──────────────────────────┘
                                    │ http（内网回环）
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │              dsh 宿主进程                 │
                    │  webServer  host: 0.0.0.0  port: 3080    │
                    │    ├ /api/remote.mux   ← 浏览器 mux      │
                    │    └ /node/v1          ← 节点通道（新）  │
                    │                                          │
                    │  ctx.fs ─────────┐                       │
                    │  ctx.subprocess ─┤ 由节点适配器实现       │
                    └──────────────────┼───────────────────────┘
                                       │ wss 拨入（节点主动出站）
                    ┌──────────────────┴───────────────────────┐
                    │        远程机器（node agent）             │
                    │  文件系统 · 进程 · PTY · 语言服务器        │
                    └──────────────────────────────────────────┘
```

要点：

- **节点主动拨入**，不需要公网地址、不需要入站端口、天然穿 NAT。这是反向隧道模式的全部理由。
- dsh 的 HTTP carrier **没有 TLS**（文档明说），TLS 必须由反代终结。所以"公网"这个选择意味着反代是必需品而非可选项。
- 节点通道与浏览器 mux 是**两条独立路径、两套鉴权**。

绑定这一环不需要新工作：`dsh web` 的 CLI 层拒绝 `--host 0.0.0.0`，但组合层不受此限——deeepseek-harness-web 的 `dsh/cordis.patch.yml` 已经是 `host: '0.0.0.0'`。

## 4. 组件与包结构

严格照抄 E2B 的形状，新增四个包：

```
packages/node/
├── node/                    @shaowenchen/dsh-node          ctx.nodeRegistry（owner）
├── fs-node/                 @deepseek-ai/dsh-fs-node       实现 ctx.fs
├── subprocess-node/         @deepseek-ai/dsh-subprocess-node 实现 ctx.subprocess
└── node-agent/              @shaowenchen/dsh-node-agent    跑在远程机器上（非插件）
```

> **落地形态见 §13。** 上面的 `packages/node/` 是**宿主侧源码布局**；目标环境是 deepseek-harness-web 的线上部署（发布版 dsh 容器），它加载不了 monorepo 源码，只认外部插件包 + patch 层。两者的对应关系在 §13.3。

### 4.1 `dsh-node`（owner）

职责边界，收得很紧：

- **注册入口**：`ctx.webServer.registerUpgrade({ path: '/node/v1', handler })`。这个 API 的语义正好是"一个 socket 只能有一个协议 owner"，就是为这种接入准备的。
- **节点身份**：注册、认证、单实例约束。
- **通道**：一个 WebSocket，多路复用逻辑流。
- **生命周期**：连接代际（generation）、心跳、断开后的世界状态。
- **不做**：不碰文件语义、不碰进程语义。那是适配器的事。

对外提供 `ctx.nodeRegistry`，最小面：

```ts
interface NodeRegistry {
  /** 当前已注册且就绪的节点，未接入时为 undefined。 */
  readonly current: NodeDescriptor | undefined
  /** 打开一条逻辑流；断开时以 node/disconnected 终止。 */
  open(op: NodeOperation, signal?: AbortSignal): NodeStream
  /** 代际号：每次重连递增，用于让适配器识别陈旧句柄。 */
  readonly generation: number
}
```

### 4.2 `dsh-fs-node` / `dsh-subprocess-node`（适配器）

两者都从 `ctx.nodeRegistry` 取唯一通道，**约定同一个执行世界**。适配器只做翻译：把 `ctx.fs` 的抽象方法映射成节点操作，把结果翻译回 `FsInfo` / `FsTarget` / `FsVersion` 等既有类型。

它们**不新增任何模型可见的概念**——和 E2B 一样，"结果看起来和本地文件结果完全一样"。

关键实现约束（照抄 E2B 的教训）：

- **路径必须是字节安全的**。E2B 用严格 base64 编码的 NUL 分帧穿越 SDK 的文本通道。我们两端都自己控制，更彻底：路径在二进制通道上作为**不透明字节串**传输，**只在节点侧解析**。宿主永远不做远程路径的规范化、拼接或 realpath。
- `resolve()` 是 async 的，注释里写明了原因："a remote/sandboxed backend may need a round-trip"。这里正好用上。
- `processPathFromHostPath()` 返回 `undefined`——宿主读不到远程文件。这是**正确**的行为，但意味着任何依赖宿主真实路径的特性（"在应用中打开"、部分上传路径）必须**显式降级**，不能假装可用。

### 4.3 `dsh-node-agent`（远程守护进程）

跑在远程机器上，不是 dsh 插件。职责：

- 一条出站 `wss` 连接到中心。
- 在本机执行文件与进程原语。
- **本地沙箱策略自己负责**（bwrap / landlock），见 §7。
- 承载的是"唯一执行世界"的实体：一个 `cwd`、一个路径命名空间、一棵进程树。

## 5. 协议

### 5.1 为什么不复用 Typert RPC

Typert / `ctx.remote` 是**为 Host 与 Client 两个 Cordis 环境**设计的：descriptor 由 Host 业务 Service 生成，Client 侧通过 `ctx.remote.$mount()` 挂载生成的 `/remote` 贡献，且"只有严格生成的贡献能挂载"。节点 agent **不是一个 Cordis 环境**，它是一台机器上的守护进程。

硬塞进去的话，要么给节点造一个假的 Cordis Client 面（凭空多一层），要么为它放宽 Typert 的生成契约（污染已有的严格性）。执行世界的操作集合小而深，独立协议更小、更诚实。

### 5.2 形状

一条 WebSocket，按 `streamId` 多路复用。控制帧 JSON，数据帧二进制：

```
→ hello        { nodeId, credential, agentVersion, platform, arch, capabilities }
← ready        { generation, cwd, home, limits }
← error        { code, message }

→ op.open      { streamId, op, args }
← op.data      { streamId, chunk }        （二进制）
← op.end       { streamId, result }
← op.error     { streamId, code, message }
→ op.cancel    { streamId }

↔ ping / pong                             （2s 节奏，沿用既有心跳设计）
```

操作集合（v1）：

| 类别 | op |
|---|---|
| 文件 | `fs.resolve` `fs.stat` `fs.lstat` `fs.readText` `fs.streamText` `fs.writeText` `fs.editText` `fs.list` `fs.copy` `fs.remove` |
| 进程 | `proc.resolve` `proc.spawn` `proc.write` `proc.signal` `proc.wait` |
| 终端 | `tty.open` `tty.write` `tty.resize` `tty.signal` `tty.close` |

设计上刻意**对齐仓库里已有的 mux 语义**（open/data/end/error/cancel、单一 `ready` 开场项、代际概念），这样评审的人看到的是熟悉的结构，而不是一套新发明的规矩。

### 5.3 心跳与超时

沿用 `api/gateway` 已验证的设计：host 每 `websocketHeartbeatIntervalMs`（默认 2s）发 Ping，对端在下一间隔前未应答即终止。既有文档对此有一条明确警告值得继承：**事件循环或网络可能停顿超过该间隔的部署，必须调大它。**

在此之上，**每个操作独立截止时间**：一个卡住的节点不能挂死一整轮对话。

## 6. 生命周期与失败语义（本方案最关键的部分）

### 6.1 连接代际

节点连接是一个**代际**，与 `ctx.connection` 的 generation 同构。所有句柄（fd、pid、PTY）都属于某个代际。重连产生新代际。

### 6.2 失败必须 fail-closed

这是整个方案里唯一一条不能妥协的安全属性：

> 节点在对话中途掉线，下一次 `ctx.fs` / `ctx.subprocess` 调用**必须抛错，绝不能静默回退到宿主**。

静默回退意味着 agent 开始在**宿主的**文件上做修改，而用户以为改的是远程机器。这是本方案能引入的最危险的故障模式，必须在实现层显式堵死：适配器发现 `ctx.nodeRegistry.current === undefined` 时，抛 `node/disconnected`，**不做任何 fallback**。

### 6.3 断线时进程怎么办

这里要区分两件不同的事，架构决策只否决了其中一件：

- **否决的**：宿主重建回调、pending promise、授权状态、协议状态、输出游标。
- **没被否决的**：节点保留自己本地的进程树。

现实诉求是明确的：一次网络抖动不该杀掉正在跑的构建。所以 v1 的立场是：

- 节点 agent **在 socket 断开后存活**，本机进程继续运行。
- 宿主**不重连、不重新附着**任何旧句柄。重连后代际 +1，世界是新的；agent 手里若有旧句柄，节点在诊断中把它标记为 `orphaned`。
- 提供策略开关 `onDisconnect: 'orphan' | 'terminate'`，**默认 `orphan`**（不毁掉进行中的工作），隔离敏感部署可选 `terminate`。

这样既不逆架构，也不因为一次网络抖动毁掉半小时的构建，而且**不会骗人**——孤立的进程是被如实报告的，不是被假装成还活着。

### 6.4 不可用就是不可用

全局唯一节点意味着没有冗余：节点不在，执行世界就不可用。这一点要在 UI 和工具层**显式呈现**，而不是表现为工具莫名其妙地失败。会话本身不受影响——会话状态在中心，agent 仍然可以"思考"，只是不能动手。

## 7. 沙箱与授权

### 7.1 沙箱：老实报告，不许假装

`ctx.sandbox` 文档写明"confinement is same-world only"，容器、microVM、远程执行器**是替换整个能力，而不是注册到 `ctx.sandbox`**。远程节点就是"另一个世界"，所以：

- 节点上的约束由 **node agent 自己**实施（bwrap / landlock，与 `sandbox-local` 同族手段）。
- 适配器必须通过 `sandboxMode` getter **如实报告**：节点具备约束能力就报告实际模式；不具备就报告 `undefined`（表示不约束）。
- **绝不能**报告一个它没有强制的模式。工具层读这个值来决定是否诚实地展示升级（escalation）字段——撒谎会让模型以为自己受到保护。

### 7.2 授权往返

审批发生在宿主，效果落在远程。`danger-full-access` 这类升级的往返必须把节点的策略纳入回路：中心批准了，节点也可能拒绝。拒绝要作为**类型化的失败**回到工具层，而不是被吞掉。

## 8. 安全：鉴权与暴露面

### 8.1 为什么不复用浏览器鉴权

现有浏览器鉴权是**为浏览器设计的**：`?token=` 换签名 cookie，cookie 绑定规范化 hostname + port，`HttpOnly`、`SameSite=Strict`，而且**故意不带 `Secure`**（因为默认走 loopback HTTP）。用它来认证一台机器是错的工具。节点走**独立的 bearer 凭证**，且**不放 query**（query 会进日志），放 header。

不过重连与公网暴露下仍需注意：

- 反代上给 `/node/v1` **单独**限流与封禁策略。
- 加入令牌是唯一的**预认证**面，必须短命、单次。
- 浏览器侧的 `TRUSTED_HOST` / Host / Origin 检查维持现状，节点通道不参与。

### 8.2 注册流程

```
1. 运维在中心：dsh node enroll --name build-01
   → 签发 join token（一次性，TTL 10 分钟）

2. 远程机器：dsh-node join --url wss://dsh.example.com/node/v1 --token <join token>
   → join token 单次换取长期凭证（nodeId + secret）
   → 中心只存哈希（走 ctx.credentials），节点侧文件 owner-only 权限

3. 之后每次连接：nodeId + secret → 认证 → 注册
```

**单实例约束**：一个 nodeId 同时只能有一条活动连接。第二条连接必须**显式地**取代或拒绝——不能含糊，因为两个 agent 同时操作一个执行世界会互相破坏。

### 8.3 凭证轮换

`ctx.credentials` 的语义可复用：删除或替换记录在下次连接激活时生效。节点侧同理。

## 9. 组合与挂载

照 E2B 的 YAML 形状：

```yaml
- name: '@shaowenchen/dsh-node'
  config:
    path: /node/v1
    cwd: /srv/workspace
    heartbeatIntervalMs: 2000
    onDisconnect: orphan

- name: '@deepseek-ai/dsh-fs-node'
- name: '@deepseek-ai/dsh-subprocess-node'
```

**一条必须显式校验的规则**：节点适配器与本地 provider **互斥**。一个进程只有一个执行世界，同时挂 `fs-local` 和 `fs-node` 是**组合错误**，必须在加载时抛出，而不是变成运行期的意外。E2B 的注释说得比我好："file and process operations would not share identity or state, defeating the coding use case."——同一件事。

### 反代配置要点

- WebSocket 升级头必须透传。
- `/node/v1` 路径**关闭缓冲**。
- 读写超时要显著大于心跳间隔，否则反代会先掐断一条健康的连接。

## 10. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 协议 + node agent + owner + `hello`/`ready` 往返 | 节点能注册、心跳存活、断开被如实报告 |
| P1 | `ctx.fs` 全部操作 | 读、写、改、列目录、原子版本语义 |
| P2 | `ctx.subprocess.spawn` | bash 命令、输出上限、取消、进程清理 |
| P3 | `ctx.subprocess.spawnTerminal` | PTY 文本 I/O、前台进程组、TERM→KILL 静默收敛 |
| P4 | LSP | **预期零额外工作**——`dsh-lsp-stdio` 消费上面两个接缝 |

P4 是这套接缝设计的回报，值得单独指出：终端和 LSP **都不是节点专属工作**。

不过在这张表之前，线上部署多了一个**真正的第零步**，它不写代码、只验证假设：**patch 层能否 disable 掉本地 provider**（§13.5）。这一条不成立，整个方案在容器里就落不了地——挂了 `fs-node` 会和 `fs-local` 撞在一起。请把它排在 P0 之前。

## 11. 验证

对齐 E2B 的验证强度：

- 包级用例锁定：节点生命周期、路径分帧（含字节切分的 UTF-8）、文件元数据与原子版本、进程发布/回滚、终端 I/O 与会话清理、输出上限、取消、释放。
- 一个凭证门控的 Loader 组合 e2e（对应 `packages/e2b/e2b/tests/composition.e2e.ts`）：从宿主看到的执行世界与节点上真实状态一致；宿主工作区**未被触碰**；最终节点释放。
- 一条**专门的失败用例**：对话中途拔掉节点连接，断言下一次文件/进程调用**抛错而非回退到宿主**。这条用例守的是 §6.2 那条安全属性，不能省。

## 12. 遗留风险与待决问题

- **会话与执行世界的绑定语义**：全局唯一节点下，节点掉线时正在进行的会话呈现成什么样？（建议：会话存活、工具不可用，理由见 §6.4）
- **`orphaned` 进程的宿命**：v1 只报告不回收。是否需要一个显式的 `dsh node reap`，何时做？
- **升级往返的拒绝路径**：节点的策略拒绝与中心的审批如何在同一处呈现给用户。
- **依赖宿主真实路径的特性清单**：需要盘一遍所有消费 `processPathFromHostPath()` 的地方，给出各自明确的降级行为。
- **协议版本协商**：`hello` 里带了 `agentVersion`，但 v1 是否要强制拒绝不匹配的版本，还是尽力兼容？建议前者——执行世界的语义错误比连接失败昂贵得多。

## 13. 落地到 deepseek-harness-web 线上部署

目标环境是 `../deepseek-harness-web`：一个 Ubuntu 容器，里面 `npm install --global @deepseek-ai/dsh@<版本>`，入口脚本起 `dsh --profile web`，workspace 与配置都在 `/root`（bind mount `./home:/root`，可选 S3 同步）。

**它加载不了 monorepo 源码。** 这决定了插件必须以**外部插件包**的形态交付。

### 13.1 三个现成的接入点

部署里已经有三样东西可以直接用，不需要改架构：

**一、`/root/.dsh/cordis.patch.yml` 是天然的用户 patch 层。**
入口脚本每次启动都做 `cp /opt/dsh-web/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"`，而文件内容就是给 `webserver` 设 `host: '0.0.0.0'`。dsh 的用户 patch 层语义很宽：**id 定位的 config 覆盖、disable、insert 列表，且允许 `!!js` 表达式**。

**二、patch 层可以挂任意本地路径的插件。**
`github-review` 的例子证明了这一点：

```yaml
- insert:
    - id: github-ready-review-rule
      name: './github-ready-review-rule.mjs'   # ← 相对路径的插件文件
```

**三、CLI 有插件管理命令。**
`dsh plugin --profile web add <package>` 把参数转发给 profile 目录里的 pnpm；profile 的 `node_modules` 在 `/root/.dsh/profiles/web/`，随 bind mount 持久化。

### 13.2 必须绕开的三个坑

**坑一：版本变更会 purge 插件目录。**
入口脚本里：`prev != DSH_VERSION` 时 `rm -rf "$DSH_HOME/profiles/web/node_modules"`。设计意图是好的——旧版本装的插件会崩溃新版本 dsh。但后果是：**每次升级 dsh，节点插件被清空**。

所以插件不能只靠"装进 profile"活着。要么接受升一次装一次，要么把安装放进镜像/entrypoint，让它随版本重建。这也正是把方案做成**独立仓库**（而非埋进 harness monorepo）的额外理由：独立包可以像 dsh 一样被 pin 住版本、随镜像重建。

**坑二：容器里没有 pnpm。**
Dockerfile 只装了 Node 24，`dsh plugin` 转发给 pnpm 会失败（"pnpm not found on PATH"）。要 `dsh plugin add` 就得在镜像里加 pnpm；否则走"预构建 tarball + patch 里写相对路径"的路线，完全不依赖包管理器。

**坑三：S3 模式下 purge 的时机不同。**
`[ -z "${S3_BUCKET:-}" ]` 时才在 entrypoint 里 purge；配了 S3 则由 `s3-sync.mjs` 在 **boot pull 之后**做同样的清理。如果线上开了 S3，还要额外确认 `profiles/web/node_modules` 不在同步排除之外——否则一次 boot pull 可能把上版本的插件从桶里拉回来。

### 13.3 包与交付形态的对应

| 设计文档里的 | 线上部署里的 |
|---|---|
| `packages/node/node` | 外部包 `dsh-node`，装进 web profile |
| `packages/node/fs-node` | 外部包 `dsh-fs-node` |
| `packages/node/subprocess-node` | 外部包 `dsh-subprocess-node` |
| `packages/node/node-agent` | 独立产物，跑在远程机器，**与容器无关** |
| YAML 组合示例（§9） | 合并进 `/root/.dsh/cordis.patch.yml` 的 `insert` 列表 |

前三个包与 node agent 建议放在**一个独立仓库**（例如 `deepseek-harness-node`），和 deepseek-harness-web 平行：前者是运行时的扩展，后者是部署打包，两者都从上游 dsh 的发布版构建。

### 13.4 线上 patch 层的样子

`dsh/cordis.patch.yml` 现在是：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080
    compression: gzip
```

按文档 mcp-memory 的警告，**不要覆盖这个文件**（它可能已含无关 patch），要把行**追加**进去：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024

- insert:
    - id: node-registry
      name: '@shaowenchen/dsh-node'
      config:
        path: /node/v1
        cwd: /root/workspace
        heartbeatIntervalMs: 2000
        onDisconnect: orphan

    - id: fs-node
      name: '@deepseek-ai/dsh-fs-node'

    - id: subprocess-node
      name: '@deepseek-ai/dsh-subprocess-node'
```

### 13.5 还有一条必须验证的假设

**patch 层能不能 `disable` 掉本地 provider，是本方案在线上环境的前提。**

执行世界要求同时只有一个：挂了 `fs-node` 就必须让 `fs-local` 停用，否则 §9 的互斥校验会在容器启动时直接抛错。

patch 层声称支持 disable，但**现有部署里的三个 patch 全部是 `insert`，没有一个是 `disable` 或 config override**——也就是说这条路径在这个部署形态下**没有先例**。P0 的验收必须包含"能否用 patch 停掉 `fs-local` / `subprocess-local`"这一条，先于任何节点代码：

```sh
docker compose exec dsh-web cat /root/.dsh/profiles/web/node_modules/... # 找到本地 provider 的 id
# 在 patch 里 disable 它，重启，确认 dsh 起得来且 fs 服务缺失
```

若 disable 不可行，退路是：让节点适配器在加载时**主动接管**——即本地 provider 仍然挂着，但节点适配器注册优先级更高、或在检测到节点已注册时让本地 provider 自我禁用。这条退路更丑，能不做就不做。

### 13.6 远程机器侧

node agent 与容器无关，但线上形态给它的部署添了两条约束：

- **TLS 在反代终结**，节点连 `wss://`，容器内是明文 HTTP。反代必须为 `/node/v1` 透传升级头、关缓冲、把读超时放大到远大于心跳间隔（默认 2s）。
- **节点凭证存哪**：容器内 `/root/.dsh/.credentials.yaml` 由 `ctx.credentials` 的本地 provider 管理，权限 0600（entrypoint 有 `umask 077` 且会主动 `chmod 600`）。节点凭证应当沿用这个位置和权限，而不是另起一份。注意 **S3 同步会把 `/root` 整体同步走**——凭证是否该进桶，需要显式决策（建议：**不进**，在同步排除项里加白名单）。

## 14. 一句话总结

不新增分布式抽象，只实现 `ctx.fs` 与 `ctx.subprocess` 两个既有接缝；用一条节点拨入的 WebSocket 承载它们；断线即世界不可用、fail-closed 绝不回退宿主；bash / PTY / LSP 因为组合在这两个接缝之上而免费获得远程能力。

## 15. 实现现状（2026-09-11 复核）

本节记录实现与本方案的偏差。方案本身不改，偏差写在这里，避免文档继续声称未实现的东西、或漏掉实际做出来的东西。

### 已实现且与方案一致

- `ctx.fs` 与 `ctx.subprocess` 两个接缝的适配器，以及归它们管的 `proc.*`、`tty.*` 操作族。
- 节点拨入、TLS 反代、单节点单槽、心跳与代数（generation）。
- **断线即世界不可用**：无节点时所有操作以 `disconnected` 拒绝，绝不回退宿主。这条有专门的测试套件锁着。

### 与方案的偏差

- **§13.5 里的 id 是错的。** 方案写的 `fs-local` / `subprocess-local` 在包层面存在，但**不是线上 profile 里挂载的 id**；真实的 id 是 `fs-sandbox`（包了一层 fs-local）和 `subprocess`。按方案的写法去 disable 会**一个都没关掉**，结果同时存在两个执行世界。README 与两个安装脚本已改为先查再关：

  ```sh
  dsh --profile <name> --dump-config | grep -E 'id: (fs|subprocess)'
  ```

- **沙箱是方案里没预见的一个缺口。** `dsh-sandbox-local` 依据 **dsh 自己所在平台**选择强隔离的执行器（macOS 用 Seatbelt，Linux 用 bwrap / Landlock），而被它包裹的命令实际运行在**节点**上。于是 macOS 宿主驱动 Linux 节点时，每条命令都被套上 `sandbox-exec`——一个 Linux 上不存在的二进制——全部失败。这个失败还极具误导性：它表现为 `spawn bash ENOENT`，指向可执行文件而非沙箱。

  节点侧的沙箱需要一个新的 provider（按节点平台选择执行器），这是一个独立的工作项。在它完成之前，宿主必须以 `DSH_PERMISSION_MODE=danger-full-access` 运行，即放弃宿主侧隔离。

- **凭证校验仍未实现。** registry 从头到尾没有读过 `credential` 字段，注册只受协议版本和单槽规则限制。`/node/v1` 不可暴露在可信网络之外。见 `SECURITY.md`。

### 尚未实现

- 会话级执行世界选择。执行世界是**进程级**的：一个 dsh 进程同一时刻只有一个世界，无法让某个会话跑本地、另一个跑远程。这与方案 §1 的非目标一致，但值得写在这里，因为它是从 Web 界面最容易被问到的问题。
- Web 界面上的节点状态面板。当前唯一的可见信号是宿主 stderr 的注册/断开日志，以及节点机器上的 `ps aux | grep agent-cli`。
- 节点侧沙箱 provider（见上）。
