import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import planModeExtension from "../examples/extensions/plan-mode/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

/**
 * Shared harness for the collaborative plan-mode extension tests.
 *
 * It drives the extension through its public surface only: registered commands, registered tools,
 * event handlers, and the recorded `pi.*` / `ctx.*` calls.
 */

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export interface HarnessOptions {
	activeTools?: string[];
	/** Answers ctx.ui.select(title, options). Return undefined to dismiss. */
	select?: (title: string, options: string[]) => string | undefined;
	/** Answers ctx.ui.confirm(title, message). Default: true. */
	confirm?: (title: string, message: string) => boolean;
	/** Names returned by pi.getCommands(). Default: ["handoff"]. */
	slashCommands?: string[];
	exec?: (command: string, args: string[]) => Promise<ExecResultLike> | ExecResultLike;
	entries?: unknown[];
	cwd?: string;
	/** When false, ctx.newSession is undefined (simulates /new being unavailable). Default: true. */
	hasNewSession?: boolean;
}

export interface ToolResult {
	content: { type: string; text?: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
interface RegisteredTool {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
}

export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function setupPlanMode(options: HarnessOptions = {}) {
	let activeTools = options.activeTools ?? ["read", "bash", "edit", "write"];
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, AnyHandler[]>();
	const entries: unknown[] = [...(options.entries ?? [])];

	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const setActiveTools = vi.fn<ExtensionAPI["setActiveTools"]>((toolNames) => {
		activeTools = [...toolNames];
	});
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>((customType, data) => {
		entries.push({ type: "custom", customType, data });
	});
	const exec = vi.fn(async (command: string, args: string[]) => {
		const result = options.exec
			? await options.exec(command, args)
			: { stdout: "", stderr: "unexpected exec", code: 1 };
		return { killed: false, ...result };
	});

	const api = {
		registerFlag: vi.fn(),
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerShortcut: vi.fn(),
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: AnyHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getFlag: vi.fn(() => false),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools,
		getCommands: vi.fn(() => (options.slashCommands ?? ["handoff"]).map((name) => ({ name }))),
		sendMessage,
		sendUserMessage,
		appendEntry,
		exec,
	} as unknown as ExtensionAPI;

	planModeExtension(api);

	const theme = { fg: (_name: string, text: string) => text, strikethrough: (text: string) => text };
	const notify = vi.fn();
	const select = vi.fn(async (title: string, choices: string[]) => options.select?.(title, choices));
	const confirm = vi.fn(async (title: string, message: string) => options.confirm?.(title, message) ?? true);
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const ui = {
		notify,
		select,
		confirm,
		editor: vi.fn(async () => undefined),
		setStatus,
		setWidget,
		setEditorText: vi.fn(),
		theme,
	};

	const replacementSendUserMessage = vi.fn();
	const replacementCtx = { ui, sendUserMessage: replacementSendUserMessage };
	const newSession = vi.fn(
		async (opts?: { parentSession?: string; withSession?: (ctx: unknown) => Promise<void> }) => {
			await opts?.withSession?.(replacementCtx);
			return { cancelled: false };
		},
	);

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: options.cwd ?? process.cwd(),
		ui,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => [],
			getSessionFile: () => "/tmp/parent-session.jsonl",
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		...(options.hasNewSession === false ? {} : { newSession }),
	} as unknown as ExtensionContext;

	async function runCommand(name: string, args = ""): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command: ${name}`);
		await command(args, ctx);
	}

	async function runTool(name: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return tool.execute("call-1", params, undefined, undefined, ctx);
	}

	/** Runs every handler registered for `event` and returns their results in registration order. */
	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload }, ctx));
		}
		return results;
	}

	async function triggerAgentEnd(text = "ok"): Promise<void> {
		await emit("agent_end", { messages: [createAssistantMessage(text)] satisfies AgentMessage[] });
	}

	/** Text of every custom message the extension asked the agent to see via before_agent_start. */
	async function injectedContext(): Promise<string> {
		const results = await emit("before_agent_start", { messageType: "user", prompt: "hi" });
		return results
			.map((r) => (r as { message?: { content?: string } } | undefined)?.message?.content ?? "")
			.join("\n");
	}

	function lastStatus(): unknown {
		const calls = setStatus.mock.calls.filter((c) => c[0] === "plan-mode");
		return calls.at(-1)?.[1];
	}

	return {
		activeTools: () => activeTools,
		appendEntry,
		commands,
		confirm,
		ctx,
		emit,
		entries,
		exec,
		injectedContext,
		lastStatus,
		newSession,
		notify,
		replacementSendUserMessage,
		runCommand,
		runTool,
		select,
		sendMessage,
		sendUserMessage,
		setActiveTools,
		tools,
		triggerAgentEnd,
	};
}

export type PlanHarness = ReturnType<typeof setupPlanMode>;
