# pi-github-flow

把 [ItQianChen/dsh-github-flow](https://github.com/ItQianChen/dsh-github-flow) v0.7.0（MIT）移植进 pi。

19 个 GitHub 工具，全部由宿主机 `gh` CLI 驱动——不存储、不转发任何凭据。

```
github_task  github_pr  github_issue  github_run  github_repo  github_help   (常驻)
+ 13 个按需工具，通过 tool_search 检索后激活
```

> 本移植版版本号 `0.1.0`，对应上游 `dsh-github-flow` v0.7.0。

## 目录结构

- `vendor/` —— 原仓库 `lib/` 的**纯逻辑层**，原样复用。零 Cordis 依赖，只调用宿主机 `gh` CLI：
  - `vendor/executor.js` + `vendor/executor/*.js` —— `GhExecutor`：参数守卫、错误分类、失败锚点、进程工具、平台指南、PR review 规则、运行日志、版本工具、git 解析
  - `vendor/tools/*.js` —— 19 个工具工厂（`image-utils.js` 是辅助模块，不是工具）
  - `vendor/renderers/*.js` —— markdown / 图片渲染器
  - `vendor/telemetry.js` —— 纯内存环形队列，**不联网**，无外部上报
- `index.ts` —— pi 适配层（约 590 行），只做三件事：实例化 executor、形状转换、注册 `/gh` 命令

### 对 vendor 的改动

vendor 保持原样，只改了下列几类内容，全部可在文件里 grep 到：

1. **宿主专属文案**（避免误导模型）
   - `vendor/tools/help.js` overview 首行：`DSH GitHub Flow 工具箱全景导航` → `GitHub Flow 工具箱全景导航`；`面向 DeepSeek Harness 的原生` → `面向 AI Agent 的原生`
   - `vendor/renderers/status.js` 报表标题：`DSH GitHub 工具链…` → `GitHub 工具链…`
2. **取消信号透传**（`【pi 移植新增】` 标记）
   - `vendor/executor.js`：新增 `export const ghAbortContext = new AsyncLocalStorage()`；`run()` 里 `const abortSignal = options.signal ?? ghAbortContext.getStore()?.signal`，并把 `signal` 并入 `commonOpts`；`catch` 顶部**先于超时分支**判定取消，返回 `{ ok:false, aborted:true, errorKind:'aborted' }`
   - `vendor/executor/process-utils.js`：`spawnWithStdin` 增加 `onAbort` 监听（与超时走同一条 `child.kill()` 路径），用 `aborted` 标记区分，`settle` 时移除监听
3. **失败原因不再丢失**（`【pi 移植新增】` 标记）
   - `vendor/renderers/common.js`：新增 `appendFailures(value)`
   - `vendor/renderers/{repo,issue,pr}.js`：`message` 早退分支接上 `appendFailures`
   - 背景：`vendor/tools/image-utils.js:241` 写着「failures 记录原因由调用方透传给 Agent」，
     但渲染器只输出 `message`，`failures` 整段被丢掉。实测后果：`raw.githubusercontent.com`
     被网络拦截时，用户只看到「请求 1 张，被拒 0 张」，无法区分网络不通 / 鉴权失败 / 非图片。
4. **文案与实现对齐**
   - `vendor/renderers/repo.js` 图片清单提示：「留空下载全部」→「传 `image_urls` 下载（不传只返回清单，传空数组会报错）」
   - 原提示与实现相反：不传 `image_urls` 时**不会**下载，传空数组还会抛错。
5. **日志前缀与示例文案改名**
   - `vendor/proxy.js`、`vendor/tool-tiers.js`：警告前缀 `[dsh-github-flow]` → `[pi-github-flow]`；探测 UA `dsh-github-flow-proxy-probe` → `pi-github-flow-proxy-probe`
   - `vendor/tools/cache.js`：报错示例里的仓库名改成 `xiyan520/pi-github-flow`
   - 有意**保留**：`vendor/proxy.js` 的持久化路径仍是 `~/.dsh/data/dsh-github-flow/proxy.json`（与 DSH 用户数据目录规范对齐，且该模块在 pi 侧未接线）
6. 其余 `DSH_SESSION_ID` 等环境变量引用保持原样：pi 不设该变量时 `GhExecutor` 会回落到 `cwd`，而适配层每次都显式传 `ctx.cwd`，不影响行为。

> **为什么用 `AsyncLocalStorage` 而不是 executor 实例字段**：pi 会在同一轮里并发执行多个工具调用，
> 实例字段会被其它调用覆盖；ALS 天然按异步调用链隔离，且 19 个工具工厂都不用改一行代码。

## 形状转换（DSH → pi）

| DSH | pi |
| --- | --- |
| `parameters`（JSON Schema 对象） | `Type.Unsafe(同一份 schema)` 同构透传 |
| `execute(args, { cwd })` | `execute(id, params, signal, onUpdate, ctx)`，`cwd` 取 `ctx.cwd` |
| `output.render(args, value)` 返回 `[{type:"text"\|"image", path}]` | `content: [{type:"text"} \| {type:"image", data: base64}]` |

## 工具暴露策略

19 个工具全塞进 prompt 会占用大量 schema token，因此分两层：

- **direct（6 个）**：`github_task`、`github_pr`、`github_issue`、`github_run`、`github_repo`、`github_help`
- **deferred（13 个）**：`github_status`、`github_release`、`github_secret`、`github_skill`、`github_label`、`github_ruleset`、`github_cache`、`github_gist`、`github_agent_task`、`github_discussion`、`github_project`、`github_codespace`、`github_api` —— 通过 `tool_search` 检索后激活调用

> **deferred 可达性**：`tool_search` 和 `codemode` 自身都是 `model-only` + `defaultActive: false`，
> pi 只在配置了 MCP 服务器时才顺带激活它们。因此本扩展在 `session_start` 检查激活集，
> 若两者都不在就补一个 `tool_search`，否则这 13 个工具既不在工具列表里、也无法被发现。
>
> 两个实现上的坑（已实测确认，代码里有注释）：
> - **只能在 `session_start` 里做**。工厂函数阶段调 `getActiveTools` / `setActiveTools` 会抛
>   `Extension runtime not initialized. Action methods cannot be called during extension loading.`
> - **不能拿「有已注册 direct 工具没被激活」判定用户收窄**。`getAllTools()` 里包含
>   `powershell` / `grep` / `find` / `ls`（都是 `direct` 但默认不激活），该条件恒为真，
>   会导致 `tool_search` 永不启用。
>
> `setActiveTools` 传的是「现有激活集 + tool_search」，不会移除任何工具。
> `tool_search` 没注册（`--exclude-tools tool_search` / `--no-builtin-tools`）→ 什么都不做。
> 要彻底关掉本行为：`PI_GITHUB_FLOW_NO_AUTO_TOOL_SEARCH=1`

### 检索关键词（`keywords`）

pi 的 `tool_search` 是 BM25，`tokenize` 只保留 `[a-z0-9]`。vendor 的工具描述是纯中文，
若不给英文同义词，13 个 deferred 工具基本只能靠工具名（`github_secret` → `github secret`）被搜到，
`forum` / `board` / `kanban` 这类常见词完全零命中。因此 `TOOL_META` 给 13 个 deferred 工具加了
`keywords` 字段，注册时追加到 `description` 尾部（`Search keywords: ...`）。

> **已知限制**：中文查询一律零命中（`密钥` / `分支保护` / `缓存` 全部返回空）。
> 这是 pi 的 `tokenize` 把非 ASCII 整段丢弃导致的，扩展侧无法修复。
> 绕行方式：用英文关键词检索，或直接用 6 个常驻的 direct 工具（`/gh` 命令也可）

## `/gh` 命令（只读）

```
/gh status          个人待办与跨仓动态看板（github_status view）
/gh pr [state]      列出 PR（open/closed/merged/all）
/gh issue [state]   列出 Issue（open/closed/all）
/gh run             最近的工作流运行
/gh repo            当前仓库信息
/gh auth            gh 安装与登录状态
/gh help            用法
```

原版 `/gh` 是 DSH 的模态框驾驶舱（可视化工作台 + 写操作入口）；pi 侧降级为 `select`/`notify` 只读浏览。
**写操作统一走 Agent 工具调用**，保持单一写入口，避免绕过 vendor 层的 `destructive.js` 危险操作闸门。

列表类子命令会把渲染器输出的 markdown 表格清洗成可读的单行选项（`cleanOption`：链接语法还原成文字、
去掉 `**`/`` ` ``/斜体标记、表格竖线降级成空格、去列表前缀），并丢弃标题行、表格分隔行、
`找到 N 个` / `最近 N 次` 汇总行；清洗后不足 2 条时直接 `notify` 全文，不弹空列表。

## 未移植的部分

| 原插件模块 | 未移植原因 |
| --- | --- |
| `src/api/`、`src/ui/`、`client/`（SWR Web 驾驶舱） | DSH Web 宿主专属能力 |
| `main.ts`（Cordis 服务注册 / 依赖注入） | pi 没有 Cordis 容器 |
| git-watcher / updater / upgrade-manager | DSH 宿主自升级链路，pi 有 `pi update` |

## 与原版的行为差异（已知）

| 差异 | 原因 | 影响 |
| --- | --- | --- |
| 未接 `attachProxyManager` | 原版代理配置读写 DSH 的配置文件 | `gh` 走系统 `HTTPS_PROXY` 环境变量 |
| 未接 `tool-tiers` 分层 | pi 有自己的 `exposure` 机制 | 分层策略由 `TOOL_META.core` 控制 |
| `/gh` 只读 | 原版是 Web 驾驶舱的写入口 | 写操作走 Agent 工具，不绕过闸门 |
| `/gh` 不触发 `tool_call` 钩子 | 命令内部直调 vendor 的 `execute`，不经 pi 工具管线 | 其它扩展的审计/审批钩子看不到 `/gh` 的调用 |

## MCP 注解

pi 的语义是：**没标 `readOnlyHint` 的工具默认被当成「可能破坏性 + 开放世界」**。
因此纯只读的 `github_help`、`github_status` 标 `{ readOnlyHint: true }`，其余 17 个标
`{ destructiveHint: true, openWorldHint: true }`。

> **已知局限（有意保留）**：pi 的 `annotations` 是**工具级静态字段**，无法表达 vendor
> `vendor/destructive.js` 里精确到 `(tool, action)` 的破坏性表（`pr merge` / `issue delete` /
> `release upload-clobber` …）。所以只能粗粒度：含写动作的工具统一标 destructive。
> 代价是 `github_pr list` 这类只读调用也会被审批扩展当成破坏性调用。
> **真正的动作级闸门在 vendor 层**：`guardDestructive` 会返回 `AWAITING_CONFIRMATION` 要求二次确认，
> 不依赖注解。

## 取消（Esc / Ctrl+C）

两条路径都接通了：

1. **调用前已取消** → 适配层前置短路，不起 `gh` 子进程
2. **飞行中取消** → `ghAbortContext`（`AsyncLocalStorage`）把宿主 `signal` 透到 `GhExecutor.run()`，
   再由 `run()` 分发给两条实际执行通道：
   - **主路径**（绝大多数 gh 调用）：`execFileAsync` + Node 内建的 `signal` 选项
   - **stdin 路径**（`gh secret set` 等需要喂 stdin 的命令）：`spawnWithStdin` 的 `abort` 监听 → `kill()`

   判定顺序上取消**先于**超时和输出超量（三者都是 `killed + SIGTERM` 形状，顺序错了会被误报）。

vendor 的工具在 `res.ok === false` 时一律 `throw new Error(res.error)`，取消也会走这条路；
适配层用 `signal?.aborted`（唯一可靠判据，不猜错误文案）把它收敛成一条
`已取消（用户中断了本次 GitHub 调用）`，而不是让模型看到一个工具故障。

> **已知差异**：`/gh` 斜杠命令内部直调 vendor 的 `execute`，**不进** `ghAbortContext`，
> 所以命令执行期间 Esc 无法取消它（工具调用路径不受影响）。
>
> **进程收尾**（`spawnWithStdin`）：`SIGTERM` 后 2s 补一发 `SIGKILL`，避免子进程忽略信号导致
> promise 永不 settle；输出超量（>15MB，stdout+stderr 合计）被杀会单独标记 `overflow`，
> 不再被误报成「执行超时，请检查网络」。

## 依赖

- `gh` CLI 已安装且 `gh auth login` 完成（凭据全程由 gh 自身持有，扩展不读取、不转发 token）
- 实测环境：Windows 11 / gh 2.103.0 / node 24.21.0 / pi 1.4.0

## 安装

```bash
# 方式一：直接克隆进扩展目录
git clone https://github.com/xiyan520/pi-github-flow.git ~/.pi/agent/extensions/pi-github-flow
```

pi 会自动加载 `~/.pi/agent/extensions/*/package.json` 里 `pi.extensions` 声明的入口，无需 `--extension`。
也可以把本仓库内容手动放到 `~/.pi/agent/extensions/pi-github-flow/`。

安装后跑 `/gh auth` 确认 `gh` 已登录；再让 Agent 调一次 `github_repo(action: "view")` 验证链路。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_GITHUB_FLOW_NO_AUTO_TOOL_SEARCH=1` | 不在 `session_start` 自动激活 `tool_search`（此时 13 个 deferred 工具将不可达，除非你自己激活） |

## 验证记录

### 功能实测（真实 `gh` / 真实 pi）

- `github_repo view` → 返回真实仓库数据（stars/forks/默认分支）
- `github_release list`（deferred 工具）→ `searchTools` 检索命中并成功执行，返回 15 条 release
- `github_pr list` 不传 `repo` → 从 cwd 的 `git remote origin` 正确推断出仓库
- 扩展在无 `--extension` 参数时被用户级目录自动加载，6 个 direct 工具出现在工具列表
- `executor.checkAuth()` → `installed:true, loggedIn:true, user:xiyan520, host:github.com`（`/gh auth` 的实际数据源）
- 所有 `/gh` 子命令的 action 已对照 vendor 枚举校验：`repo:view`、`status:view`、`pr:list`、`issue:list`、`run:list` 均存在

### 回归测试（109 条断言，全绿）

| 套件 | 覆盖 | 断言 |
| --- | --- | --- |
| `abort-test` | `spawnWithStdin` 取消/超时/正常路径、`GhExecutor` 直传与 ALS 注入、并发隔离 | 18 |
| `discover-test` | `session_start` 自动启用、幂等、工厂阶段不调 action、未注册不动作、env 关闭、内置工具未激活不误判 | 15 |
| `ux-test` | MCP 注解、`/gh issue`（空/非空）、`/gh repo`、`/gh auth`、`/gh help`、非法 state | 22 |
| `exec-abort-test` | 工具 `execute` 前置短路、飞行中取消、正常回归、`/gh run`/`/gh status` 选项清洗 | 11 |
| `search-test` | 13 个 deferred 工具逐个被真实 BM25 命中、激活集被扩展且不清除原工具 | 18 |
| `fix-test` | 图片内联上限（体积/张数）、循环引用不炸、非 TUI 模式 `/gh` 有 stdout、超量被杀不报超时、EPIPE 不挂死、下载失败原因不被丢弃 | 25 |

另外用真实 `pi -p`（无 `--extension` 参数、走用户级目录自动加载）验证过端到端链路：
`tool_search` 被自动激活 → 检索 `gist` → 命中 `github_gist`；`github_repo view` 返回真实数据。

## 许可证

MIT。详见 [LICENSE](./LICENSE)。

`vendor/` 目录是 [ItQianChen/dsh-github-flow](https://github.com/ItQianChen/dsh-github-flow) 的衍生作品
（同样 MIT），版权归原作者所有。本仓库只做了 [上面列出的改动](#对-vendor-的改动)。
