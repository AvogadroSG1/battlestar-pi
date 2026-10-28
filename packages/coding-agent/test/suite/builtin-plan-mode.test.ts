import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

// The plan-mode example restored exactly as upstream ships it.
const UPSTREAM_PLAN_MODE_EXAMPLE = fileURLToPath(
	new URL("../../examples/extensions/plan-mode/index.ts", import.meta.url),
);

interface StartOptions {
	/** Global settings.json of the harness. */
	settings?: Record<string, unknown>;
	/** Files written into the user's global extensions directory. */
	userExtensions?: Record<string, string>;
}

describe("built-in plan mode", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function startHarness(options: StartOptions = {}) {
		const root = mkdtempSync(join(tmpdir(), "bs-builtin-plan-mode-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
		if (options.userExtensions) {
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			for (const [name, source] of Object.entries(options.userExtensions)) {
				writeFileSync(join(extensionsDir, name), source);
			}
		}

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
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, loader };
	}

	function planCommands(harness: Harness) {
		return harness.session.extensionRunner
			.getRegisteredCommands()
			.filter((command) => command.name === "plan")
			.map((command) => ({ invocationName: command.invocationName, path: command.sourceInfo.path }));
	}

	async function firstPlanningStep(harness: Harness): Promise<string> {
		let content = "";
		await vi.waitFor(() => {
			const step = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.customType === "plan-step");
			expect(step).toBeDefined();
			content = step && step.type === "custom_message" && typeof step.content === "string" ? step.content : "";
		});
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		return content;
	}

	it("starts plan mode at its first planning step when no user or project extensions are installed", async () => {
		const { harness } = await startHarness();
		harness.setResponses([fauxAssistantMessage("Judging readiness.")]);

		await harness.session.prompt("/plan add a dark theme");

		expect(await firstPlanningStep(harness)).toContain("Current phase: readiness");
		expect(harness.session.getActiveToolNames()).not.toContain("write");
		expect(harness.session.getActiveToolNames()).not.toContain("edit");
	});

	it("registers /plan only from the built-in when the upstream example is not installed", async () => {
		const { harness, loader } = await startHarness();

		expect(planCommands(harness)).toEqual([{ invocationName: "plan", path: "builtin:plan-mode" }]);
		expect(loader.getExtensions().extensions.filter((extension) => extension.path.includes("examples"))).toEqual([]);
	});

	it("reports the duplicate /plan and keeps the built-in active when the upstream example is also installed", async () => {
		const { harness, loader } = await startHarness({
			userExtensions: {
				"upstream-plan-mode.ts": `export { default } from ${JSON.stringify(UPSTREAM_PLAN_MODE_EXAMPLE)};\n`,
			},
		});
		const result = loader.getExtensions();
		const diagnostics = [
			...result.errors.map((error) => error.error),
			...(result.warnings ?? []).map((warning) => warning.warning),
		];

		expect(diagnostics.some((message) => message.includes("/plan"))).toBe(true);
		expect(harness.session.extensionRunner.getCommand("plan")?.sourceInfo.path).toBe("builtin:plan-mode");

		harness.setResponses([fauxAssistantMessage("Judging readiness.")]);
		await harness.session.prompt("/plan");
		expect(await firstPlanningStep(harness)).toContain("Current phase: readiness");
	});

	it("has no /plan when the built-in is disabled in settings", async () => {
		const { harness } = await startHarness({ settings: { extensions: ["-builtin:plan-mode"] } });

		expect(planCommands(harness)).toEqual([]);
	});
});
