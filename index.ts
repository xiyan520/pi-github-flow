/**
 * pi-github-flow —— 把 dsh-github-flow 移植到 pi 的适配层
 *
 * 原项目：https://github.com/ItQianChen/dsh-github-flow (MIT, v0.7.0)
 *
 * 移植策略：
 * - vendor/ 存放原插件 lib/ 的**纯逻辑层**（GhExecutor + 19 个工具工厂 + markdown 渲染器），
 *   这部分零 Cordis 依赖，只调用宿主机 `gh` CLI，可原样复用。
 * - 未移植：DSH 的 Web 驾驶舱（src/api + src/ui + client）、Cordis 服务注册（main.ts）、
 *   git-watcher / updater / upgrade-manager —— 这些是 DSH 宿主专属能力，pi 无对应物。
 * - 本文件只做三件事：实例化 GhExecutor、把 DSH 工具形状转成 pi 工具形状、注册 /gh 命令。
 *
 * DSH 工具形状 → pi 工具形状的映射：
 *   parameters(JSON Schema)  → Type.Unsafe(同构透传)
 *   execute(args, {cwd})     → execute(toolCallId, params, signal, onUpdate, ctx)
 *   output.render(args,v)    → content 数组（text 直传；image 的 path 转 base64）
 */

import fs from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { GhExecutor, ghAbortContext } from "./vendor/executor.js";
import { createTaskTool } from "./vendor/tools/task.js";
import { createPrTool } from "./vendor/tools/pr.js";
import { createIssueTool } from "./vendor/tools/issue.js";
import { createRunTool } from "./vendor/tools/run.js";
import { createRepoTool } from "./vendor/tools/repo.js";
import { createHelpTool } from "./vendor/tools/help.js";
import { createReleaseTool } from "./vendor/tools/release.js";
import { createSecretTool } from "./vendor/tools/secret.js";
import { createSkillTool } from "./vendor/tools/skill.js";
import { createLabelTool } from "./vendor/tools/label.js";
import { createRulesetTool } from "./vendor/tools/ruleset.js";
import { createCacheTool } from "./vendor/tools/cache.js";
import { createGistTool } from "./vendor/tools/gist.js";
import { createStatusTool } from "./vendor/tools/status.js";
import { createAgentTaskTool } from "./vendor/tools/agent-task.js";
import { createDiscussionTool } from "./vendor/tools/discussion.js";
import { createProjectTool } from "./vendor/tools/project.js";
import { createCodespaceTool } from "./vendor/tools/codespace.js";
import { createApiTool } from "./vendor/tools/api.js";

/** DSH 工具定义的运行时形状（由 vendor/tools/*.js 的工厂函数产出）。 */
interface DshTool {
	name: string;
	description: string;
	parameters: unknown;
	output?: {
		schema?: unknown;
		render?: (args: unknown, value: unknown) => unknown;
	};
	execute: (args: unknown, execContext: { cwd: string; sessionId?: string }) => Promise<unknown>;
}

/**
 * 每个工具的展示元信息。
 * - `core: true` 直接声明给模型；其余走 deferred（由 tool_search / codemode 按需激活）。
 * - `snippet` 会进系统提示的 Available tools 段，**必须与工具真实的 action 枚举一致**，
 *   否则模型会照着写非法 action，白白吃一轮 schema 校验失败。
 */
const TOOL_META: Record<
	string,
	{ label: string; core?: boolean; readOnly?: boolean; snippet?: string; keywords?: string }
> = {
	github_task: {
		label: "GitHub Task",
		core: true,
		snippet: "任务级原语：review_pr / diagnose_ci / prepare_release，一次调用返回结论+事实+下一步",
	},
	github_pr: {
		label: "GitHub PR",
		core: true,
		snippet: "Pull Request：list / view / diff / checks / review / merge / checkout / status / ready",
	},
	github_issue: {
		label: "GitHub Issue",
		core: true,
		snippet: "Issue 流转：list / view / create / comment / close / reopen / edit / develop",
	},
	github_run: {
		label: "GitHub Actions Run",
		core: true,
		snippet: "Actions 工作流：list / view / log_failed / rerun / cancel / trigger / workflow_* / download",
	},
	github_repo: {
		label: "GitHub Repo",
		core: true,
		snippet: "仓库与检索：view / readme / read_file / read_dir / search_code / search_repos / sync",
	},
	github_help: {
		label: "GitHub Help",
		core: true,
		readOnly: true,
		// 注意：github_help 没有 action 参数，入参是 { topic, gh_command }
		snippet: "本工具集索引（topic: overview/mapping/pr/... ，或 gh_command 查某条 gh 命令手册）",
	},
	github_status: {
		label: "GitHub Status",
		readOnly: true,
		keywords: "status health diagnostics audit dashboard todo activity summary",
	},
	github_release: {
		label: "GitHub Release",
		keywords: "release releases tag tags publish changelog semver version bump draft notes",
	},
	github_secret: {
		label: "GitHub Secret",
		keywords: "secret secrets actions environment variable env credentials token encrypt",
	},
	github_skill: { label: "GitHub Skill", keywords: "skill skills publish install agent skill registry" },
	github_label: { label: "GitHub Label", keywords: "label labels tag tags taxonomy issue label color" },
	github_ruleset: {
		label: "GitHub Ruleset",
		keywords: "ruleset rulesets branch protection policy required checks merge queue",
	},
	github_cache: {
		label: "GitHub Actions Cache",
		keywords: "cache caches actions cache cleanup purge evict storage artifacts",
	},
	github_gist: { label: "GitHub Gist", keywords: "gist gists snippet snippets paste share code fragment" },
	github_agent_task: {
		label: "GitHub Agent Task",
		keywords: "agent task copilot delegate automation coding agent dispatch",
	},
	github_discussion: {
		label: "GitHub Discussion",
		keywords: "discussion discussions forum community q&a announcement thread",
	},
	github_project: {
		label: "GitHub Project v2",
		keywords: "project projects board boards kanban v2 roadmap column item",
	},
	github_codespace: {
		label: "GitHub Codespace",
		keywords: "codespace codespaces cloud ide devcontainer remote machine",
	},
	github_api: {
		label: "GitHub API",
		keywords: "api rest graphql raw endpoint request http method pagination",
	},
};

/**
 * pi 的图片内容块只接受这四种 MIME（`dist/utils/image-process.js` 的 normalizeSupportedImageMimeType）。
 * vendor 还会产出 image/svg+xml —— 直接内联会被 provider 拒，因此只给路径。
 */
const INLINE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 单图内联上限：provider 普遍限制单图 5MB，base64 又膨胀 4/3，所以按原始字节 3.5MB 设安全线。 */
const INLINE_IMAGE_MAX_BYTES = 3_500_000;
/** 单次结果最多内联几张图：一次塞太多图会顶爆上下文与请求体积。 */
const INLINE_IMAGE_MAX_COUNT = 4;

/** 把 DSH 的 render 输出（text / image{path}）转成 pi 的 content 数组。导出以便单测。 */
export function toPiContent(def: DshTool, args: unknown, value: unknown): any[] {
	let blocks: unknown;
	let renderError = "";
	if (def.output?.render) {
		try {
			blocks = def.output.render(args, value);
		} catch (err) {
			renderError = err instanceof Error ? err.message : String(err);
		}
	}
	if (typeof blocks === "string") blocks = [{ type: "text", text: blocks }];
	if (!Array.isArray(blocks)) {
		let text: string;
		if (typeof value === "string") {
			text = value;
		} else {
			// JSON.stringify 对 Buffer / 循环引用会抛或产出数 MB 文本；失败不能让整个工具调用挂掉
			try {
				text = JSON.stringify(value ?? null, null, 2) ?? String(value);
			} catch (err) {
				text = `(结果无法序列化: ${err instanceof Error ? err.message : String(err)})`;
			}
			if (text.length > 200_000) text = `${text.slice(0, 200_000)}\n…（已截断）`;
		}
		const prefix = renderError ? `⚠️ 渲染器异常（${renderError}），以下为原始结果：\n\n` : "";
		blocks = [{ type: "text", text: prefix + text }];
	}

	const content: any[] = [];
	let inlineCount = 0;
	for (const block of blocks as any[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "image" && typeof block.path === "string") {
			const mime = typeof block.mimeType === "string" ? block.mimeType : "";
			if (!INLINE_IMAGE_MIME.has(mime)) {
				content.push({
					type: "text",
					text: `[图片未内联] ${block.path}${mime ? ` (${mime})` : ""} —— 该格式不支持内联，需要时用 read 工具读取该路径`,
				});
				continue;
			}
			if (inlineCount >= INLINE_IMAGE_MAX_COUNT) {
				content.push({
					type: "text",
					text: `[图片未内联] ${block.path} —— 超出单次内联上限（${INLINE_IMAGE_MAX_COUNT} 张），需要时用 read 工具读取该路径`,
				});
				continue;
			}
			// 超限时不内联也不报错：降级成路径，否则整个请求会被 provider 以图片过大 4xx 打回
			let size = 0;
			try {
				size = fs.statSync(block.path).size;
			} catch {
				/* 交给下面的 readFileSync 统一报错 */
			}
			if (size > INLINE_IMAGE_MAX_BYTES) {
				content.push({
					type: "text",
					text: `[图片未内联] ${block.path} —— ${(size / 1048576).toFixed(1)}MB 超过 ${(INLINE_IMAGE_MAX_BYTES / 1048576).toFixed(1)}MB 内联上限，需要时用 read 工具读取该路径`,
				});
				continue;
			}
			try {
				const data = fs.readFileSync(block.path).toString("base64");
				content.push({ type: "image", data, mimeType: mime });
				inlineCount++;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				content.push({ type: "text", text: `[图片读取失败] ${block.path}: ${msg}` });
			}
		}
	}
	if (content.length === 0) content.push({ type: "text", text: "(无输出)" });
	return content;
}

/** 给 details 用的轻量摘要：details 会随工具结果写进会话文件，不放完整 payload。 */
function summarize(value: unknown, params: unknown): Record<string, unknown> {
	const v = (value ?? {}) as Record<string, unknown>;
	const p = (params ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof p.action === "string") out.action = p.action;
	if (v.aborted === true) out.status = "aborted";
	else if (typeof v.status === "string") out.status = v.status;
	else if (v.ok === false) out.status = "error";
	else out.status = "ok";
	return out;
}

/** 实例化一次 executor，全部工具共享（与原插件的依赖注入一致）。 */
function buildRuntime(): { executor: GhExecutor; tools: DshTool[] } {
	const executor = new GhExecutor();
	const tools = [
		createTaskTool(executor),
		createPrTool(executor),
		createIssueTool(executor),
		createRunTool(executor),
		createRepoTool(executor),
		createHelpTool(executor),
		createReleaseTool(executor),
		createSecretTool(executor),
		createSkillTool(executor),
		createLabelTool(executor),
		createRulesetTool(executor),
		createCacheTool(executor),
		createGistTool(executor),
		createStatusTool(executor),
		createAgentTaskTool(executor),
		createDiscussionTool(executor),
		createProjectTool(executor),
		createCodespaceTool(executor),
		createApiTool(executor),
	] as DshTool[];
	return { executor, tools };
}

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message || String(err);
	return String(err);
}

export default function piGithubFlow(pi: ExtensionAPI) {
	const { executor, tools } = buildRuntime();
	const deferredNames: string[] = [];

	for (const def of tools) {
		const meta = TOOL_META[def.name] ?? { label: def.name };
		const core = meta.core === true;
		if (!core) deferredNames.push(def.name);
		pi.registerTool({
			name: def.name,
			label: meta.label,
			// keywords 追加到 description 尾部：pi 的 tool_search 用 BM25 扫 description，
			// 而 vendor 的描述是纯中文；pi 的 tokenize 只保留 [a-z0-9]，中文会被整段丢弃。
			// 不给英文同义词，deferred 工具就只靠工具名被搜到（forum/board/kanban 全查不到）。
			description: meta.keywords
				? `${def.description}\n\nSearch keywords: ${meta.keywords}`
				: def.description,
			...(meta.snippet ? { promptSnippet: meta.snippet } : {}),
			// DSH 的 parameters 是运行时 JSON Schema 对象，无法在编译期推导成 TSchema 泛型，
			// 因此 params 只能是 unknown，schema 由 pi 在调用前按 JSON Schema 校验。
			parameters: Type.Unsafe(def.parameters as any),
			exposure: core ? "direct" : "deferred",
			// MCP 注解语义：没标 readOnlyHint 的工具默认被当成「可能破坏性 + 开放世界」。
			// 但 pi 的 annotations 是**工具级静态字段**，无法表达 vendor `destructive.js` 里
			// 精确到 (tool, action) 的破坏性表（pr merge / issue delete / release upload-clobber…）。
			// 所以只能粗粒度：含写动作的工具统一标 destructive，真正的动作级闸门在 vendor 层
			// （`guardDestructive` 会返回 AWAITING_CONFIRMATION 要求二次确认）。
			// 代价是 github_pr list 这类只读调用也会被审批扩展当成破坏性；这一点已在 README 标注。
			annotations: meta.readOnly
				? { readOnlyHint: true }
				: { destructiveHint: true, openWorldHint: true },
			execute: async (
				_toolCallId: string,
				params: unknown,
				signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: any,
			) => {
				// 取消信号有两条路径：
				// 1) 前置短路——已经取消的调用不必再起 gh 子进程；
				// 2) 飞行中取消——靠 ghAbortContext 把 signal 透到 vendor 的每次 gh 调用（工具代码零改动）。
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "已取消（调用前收到 abort 信号）" }],
						details: { status: "aborted" },
					};
				}
				try {
					const value = await ghAbortContext.run({ signal }, () =>
						def.execute(params, { cwd: ctx.cwd }),
					);
					return { content: toPiContent(def, params, value), details: summarize(value, params) };
				} catch (err) {
					// vendor 的 97 个调用点在 res.ok === false 时一律 `throw new Error(res.error)`，
					// 取消也会走这条路。用户主动中断不该被当成工具故障报给模型，
					// 所以在这里收敛成一条可读的取消结果（signal 是唯一可靠判据，不猜错误文案）。
					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "已取消（用户中断了本次 GitHub 调用）" }],
							details: { status: "aborted" },
						};
					}
					throw err;
				}
			},
		} as any);
	}

	ensureDeferredDiscoverable(pi, deferredNames);
	registerGhCommand(pi, executor, tools);
}

/**
 * deferred 工具默认既不在工具列表里、也不能被 `tool_search` 发现 ——
 * `tool_search` 与 `codemode` 自身都是 `defaultActive: false`，只有配了 MCP 服务器时
 * MCP 扩展才会顺带激活它们。所以这里补一个 `tool_search`。
 *
 * 说明：
 * - 只能在 `session_start` 里做：`getActiveTools` / `setActiveTools` 在扩展加载阶段会抛
 *   `Extension runtime not initialized`（已实测确认），所以工厂函数里调无效。
 * - `setActiveTools` 是加法的：我们传的是「现有激活集 + tool_search」，不会移除任何工具。
 * - `tool_search` 没注册（`--exclude-tools tool_search` / `--no-builtin-tools`）→ 什么都不做。
 * - 需要彻底关闭本行为：`PI_GITHUB_FLOW_NO_AUTO_TOOL_SEARCH=1`。
 *
 * 曾经试过用「有已注册的 direct 工具没被激活」来判定用户显式收窄，实测不成立：
 * `getAllTools()` 里包含 `powershell`/`grep`/`find`/`ls` 等默认不激活的内置工具，
 * 该条件恒为真，会导致永远不激活 `tool_search`。
 */
function ensureDeferredDiscoverable(pi: ExtensionAPI, deferredNames: string[]) {
	if (deferredNames.length === 0) return;
	if (process.env.PI_GITHUB_FLOW_NO_AUTO_TOOL_SEARCH === "1") return;

	pi.on("session_start", () => {
		try {
			const all = pi.getAllTools() as Array<{ name: string }>;
			if (!all.some((t) => t.name === "tool_search")) return;
			const active = pi.getActiveTools();
			// 只认 tool_search：`exposure: "deferred"` 的定义是「codemode 也不列，只有 tool_search 能找」，
			// 所以 codemode 已激活并不代表这 13 个工具可达。
			if (active.includes("tool_search")) return;
			pi.setActiveTools([...active, "tool_search"]);
		} catch (err) {
			// 激活失败 = 13 个 deferred 工具彻底不可达，模型侧只会表现为「这些能力不存在」，不能静默
			console.warn(
				`[pi-github-flow] 无法自动启用 tool_search，${deferredNames.length} 个按需工具将不可达：` +
					(err instanceof Error ? err.message : String(err)),
			);
		}
	});
}

/** 各工具真实的 state 枚举，用于 /gh 子命令的白名单校验。 */
const LIST_STATES: Record<string, string[]> = {
	pr: ["open", "closed", "merged", "all"],
	issue: ["open", "closed", "all"],
};

/**
 * /gh —— 原插件 /gh 人类快捷指令的精简移植。
 * 原版依赖 DSH 的模态框驾驶舱；这里用 pi 的 select / notify 做只读浏览，
 * 写操作仍交给 Agent 工具（保持单一写入口，避免绕过 vendor 层的 destructive 闸门）。
 */
function registerGhCommand(pi: ExtensionAPI, executor: GhExecutor, tools: DshTool[]) {
	const byName = new Map(tools.map((t) => [t.name, t]));

	const runTool = async (
		name: string,
		args: Record<string, unknown>,
		ctx: ExtensionCommandContext,
	): Promise<string> => {
		const def = byName.get(name);
		if (!def) throw new Error(`工具未注册: ${name}`);
		const value = await def.execute(args, { cwd: ctx.cwd });
		const blocks = toPiContent(def, args, value);
		return blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n\n");
	};

	/**
	 * 统一的输出出口：TUI 走 notify，非 TUI（`pi -p` / rpc）写 stdout。
	 * 只在 notify 上打转的话，`pi -p "/gh pr"` 会零输出——命令看着「成功」了但什么都没发生。
	 */
	const say = (
		ctx: ExtensionCommandContext,
		text: string,
		level: "info" | "warning" | "error" = "info",
	) => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else process.stdout.write(`${text}\n`);
	};

	/** 表格分隔行，如 `| :--- | --- |`（整行只能由空白/冒号/竖线/短横组成，且至少一个短横） */
	const isTableRule = (line: string): boolean =>
		/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);

	/** 纯装饰行：标题 / 引用 / 代码围栏 / HTML / 分隔线 —— 不适合当选项 */
	const isDecoration = (line: string): boolean =>
		/^\s*(#{1,6}\s|>|```|<)/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line);

	/**
	 * 把 markdown 行清洗成可读的单行选项。
	 *
	 * 渲染器输出的是表格（`| #9 | CLOSED | 标题 | ... |`），直接当选项会满屏竖线；
	 * 这里把链接语法还原成文字、去掉强调/代码标记、竖线降级成空格、去列表前缀。
	 */
	const cleanOption = (line: string): string =>
		line
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/`/g, "")
			.replace(/\*\*/g, "")
			.replace(/~~/g, "")
			// 斜体只剥完整包裹的，且不允许跨过另一个 *（旧的 `^\*(.*)\*$` 会把 `*a* 与 *b*` 改成 `a* 与 *b`）
			.replace(/^\*([^*]+)\*$/, "$1")
			// 注意：不处理 `__bold__`。`__init__.py`、`feat__x` 这类标识符会被误伤，
			// 而 vendor 的渲染器只用 `**` 做强调，`__` 分支没有收益。
			.replace(/\s*\|\s*/g, "  ")
			.replace(/^\s*[-*+]\s+/, "")
			.replace(/\s{2,}/g, " ")
			.trim();

	const showList = async (
		ctx: ExtensionCommandContext,
		title: string,
		text: string,
	) => {
		const raw = text
			.split("\n")
			.map((l) => l.trimEnd())
			.filter((l) => l.trim().length > 0);
		if (raw.length === 0) {
			say(ctx, `${title}：无数据`);
			return;
		}
		if (!ctx.hasUI) {
			say(ctx, `${title}\n${text}`);
			return;
		}

		const options: string[] = [];
		for (let i = 0; i < raw.length; i++) {
			const line = raw[i];
			if (isTableRule(line) || isDecoration(line)) continue;
			// 表头：本行是表格行且下一行是分隔行 —— 它是列名，不是条目
			if (line.trim().startsWith("|") && isTableRule(raw[i + 1] ?? "")) continue;
			const clean = cleanOption(line);
			if (!clean) continue;
			// 汇总行（「找到 4 个 Issue」）不进选项
			if (/^(找到|共|最近)\s*\d+/.test(clean)) continue;
			// select 无法区分完全相同的选项，去重
			if (options.includes(clean)) continue;
			options.push(clean);
		}

		if (options.length < 2) {
			// 只有一行结论（如「📭 暂无」）或全被滤掉 → 直接提示，不弹空列表
			say(ctx, `${title}\n${text}`);
			return;
		}
		const picked = await ctx.ui.select(title, options);
		if (picked) say(ctx, picked);
	};

	pi.registerCommand("gh", {
		description: "GitHub 工作台（只读）：status / pr / issue / run / repo / auth / help",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "pr", "issue", "run", "repo", "auth", "help"];
			const hit = subs.filter((s) => s.startsWith(prefix));
			return hit.length > 0 ? hit.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const parts = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
			const rest = parts.slice(1);

			try {
				if (!sub || sub === "help") {
					say(
						ctx,
						[
							"用法: /gh <子命令>",
							"  status          个人待办与动态看板（github_status view）",
							"  pr [state]      列出 PR（open|closed|merged|all）",
							"  issue [state]   列出 Issue（open|closed|all）",
							"  run             最近的工作流运行",
							"  repo            当前仓库信息",
							"  auth            gh 安装与登录状态",
							"写操作请直接让 Agent 调用 github_pr / github_issue 等工具。",
						].join("\n"),
					);
					return;
				}

				if (sub === "auth") {
					// 注意：github_repo 没有 auth 这个 action，登录态只能走 executor.probeAuth/checkAuth。
					const auth = await executor.checkAuth(ctx.cwd);
					const lines = [
						`gh 安装: ${auth.installed ? "✓" : "✗"}`,
						`登录状态: ${auth.loggedIn ? "✓ 已登录" : "✗ 未登录"}`,
					];
					if (auth.user) lines.push(`账号: ${auth.user}`);
					if (auth.host) lines.push(`主机: ${auth.host}`);
					if (Array.isArray(auth.scopes) && auth.scopes.length > 0)
						lines.push(`权限范围: ${auth.scopes.join(", ")}`);
					if (!auth.installed) lines.push("安装提示: 见 https://cli.github.com/");
					if (!auth.loggedIn && auth.installed) lines.push("登录提示: 运行 gh auth login");
					const text = lines.join("\n");
					say(ctx, text, auth.loggedIn ? "info" : "warning");
					return;
				}

				if (sub === "repo") {
					const text = await runTool("github_repo", { action: "view" }, ctx);
					say(ctx, text);
					return;
				}

				if (sub === "pr" || sub === "issue") {
					const allowed = LIST_STATES[sub];
					const state = rest[0] ?? "open";
					if (!allowed.includes(state)) {
						say(ctx, `非法 state: ${state}（可用: ${allowed.join(" / ")}）`, "warning");
						return;
					}
					const name = sub === "pr" ? "github_pr" : "github_issue";
					const text = await runTool(name, { action: "list", state, limit: 20 }, ctx);
					await showList(ctx, `GitHub ${sub.toUpperCase()} (${state})`, text);
					return;
				}

				if (sub === "run") {
					const text = await runTool("github_run", { action: "list", limit: 15 }, ctx);
					await showList(ctx, "最近的工作流运行", text);
					return;
				}

				if (sub === "status") {
					const text = await runTool("github_status", { action: "view" }, ctx);
					await showList(ctx, "GitHub 待办与动态", text);
					return;
				}

				say(ctx, `未知子命令: ${sub}（/gh help 查看用法）`, "warning");
			} catch (err) {
				say(ctx, `/gh ${sub} 失败: ${errorText(err)}`, "error");
			}
		},
	});
}
