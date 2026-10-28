import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMode } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

// BDD contract for battlestar-pi-oev.4: the always-on plan-mode note and the plan-mode proposal.
// Interface: the note is the system prompt section `plan_mode` (rendered `<plan_mode>...</plan_mode>`);
// the proposal is the tool `propose_plan_mode` with `{ request, reason }`, accepted through ctx.ui.confirm.

const PROPOSAL_TOOL = "propose_plan_mode";
const NOTE_SECTION = /<plan_mode>\n([\s\S]*?)\n<\/plan_mode>/;

function planModeNote(context: TranscriptContext): string | undefined {
	return NOTE_SECTION.exec(getCurrentSystemPrompt(context.messages))?.[1];
}

function toolNames(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages).map((tool) => tool.name);
}

describe("plan-mode note and proposal", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function startSession(mode: ExtensionMode, confirm: () => Promise<boolean> = async () => false) {
		const root = mkdtempSync(join(tmpdir(), "bs-plan-proposal-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: builtInExtensions,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const harness: Harness = await createHarness({ resourceLoader: loader });
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode });
		return harness;
	}

	/** Runs one ordinary turn and returns what the model received. */
	async function turn(harness: Harness, text: string): Promise<TranscriptContext> {
		let received: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				received = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt(text);
		if (!received) throw new Error("the model was not called");
		return received;
	}

	function planStep(harness: Harness): string | undefined {
		const entry = harness.sessionManager
			.getEntries()
			.find((e) => e.type === "custom_message" && e.customType === "plan-step");
		return entry && entry.type === "custom_message" && typeof entry.content === "string" ? entry.content : undefined;
	}

	it("carries a byte-identical plan-mode note in every interactive turn", async () => {
		const harness = await startSession("tui");

		const first = planModeNote(await turn(harness, "hello"));
		const second = planModeNote(await turn(harness, "and now something else"));

		expect(first).toBeDefined();
		expect(first).toContain("/plan");
		expect(second).toBe(first);
	});

	it("starts plan mode with the request carried over when the user accepts a proposal", async () => {
		const harness = await startSession("tui", async () => true);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(PROPOSAL_TOOL, { request: "add a dark theme", reason: "touches many modules" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Plan mode is on."),
			fauxAssistantMessage("Judging readiness."),
			fauxAssistantMessage("Judging readiness."),
		]);

		await harness.session.prompt("add a dark theme");

		await vi.waitFor(() => expect(planStep(harness)).toContain("add a dark theme"));
		expect(harness.session.getActiveToolNames()).not.toContain("write");
	});

	it("changes nothing when the user declines a proposal", async () => {
		const harness = await startSession("tui", async () => false);
		const toolsBefore = harness.session.getActiveToolNames();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(PROPOSAL_TOOL, { request: "add a dark theme", reason: "touches many modules" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Continuing without plan mode."),
		]);

		await harness.session.prompt("add a dark theme");

		expect(planStep(harness)).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toEqual(toolsBefore);
		expect(harness.session.getActiveToolNames()).toContain("write");
	});

	it.each(["print", "rpc"] as const)("carries neither the note nor the proposal tool in %s mode", async (mode) => {
		const harness = await startSession(mode);

		const context = await turn(harness, "hello");

		expect(planModeNote(context)).toBeUndefined();
		expect(toolNames(context)).not.toContain(PROPOSAL_TOOL);
		expect(harness.session.getActiveToolNames()).not.toContain(PROPOSAL_TOOL);
	});

	it("offers the proposal tool in interactive sessions", async () => {
		const harness = await startSession("tui");

		expect(toolNames(await turn(harness, "hello"))).toContain(PROPOSAL_TOOL);
	});
});
