import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

// BDD contract for battlestar-pi-oev.3 (ADR 0002): core skills are plan mode's private resources.

const CORE_SKILLS = [
	"grill-with-docs",
	"grilling",
	"domain-modeling",
	"to-tickets",
	"handoff",
	"tdd",
	"code-review",
	"diagnosing-bugs",
	"codebase-design",
	"beads",
];
const CORE_SKILLS_DIR = fileURLToPath(new URL("../../core-skills/", import.meta.url));

function pinnedSkill(name: string): { description: string; body: string } {
	const text = readFileSync(join(CORE_SKILLS_DIR, name, "SKILL.md"), "utf8");
	const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
	return { description, body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() };
}

function writeSkill(dir: string, name: string, body: string): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(
		join(dir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: A ${name} skill the user installed.\n---\n\n${body}\n`,
	);
}

describe("core skills are private to plan mode", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function startSession(setup: (dirs: { agentDir: string; cwd: string }) => void = () => {}) {
		const root = mkdtempSync(join(tmpdir(), "bs-core-skills-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		setup({ agentDir, cwd });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: builtInExtensions,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload({ resolveProjectTrust: async () => true });
		const harness: Harness = await createHarness({ resourceLoader: loader });
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return harness;
	}

	/** Sends `text` and returns everything the model received for that turn. */
	async function modelInput(harness: Harness, text: string): Promise<string> {
		let received = "";
		harness.setResponses([
			(context) => {
				received = JSON.stringify(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt(text);
		return received;
	}

	it("keeps every core skill name and description out of an ordinary session's system prompt", async () => {
		const harness = await startSession();

		const systemPrompt = harness.session.systemPrompt;

		for (const name of CORE_SKILLS) {
			expect(systemPrompt).not.toContain(`<name>${name}</name>`);
			expect(systemPrompt).not.toContain(pinnedSkill(name).description);
		}
	});

	it("runs nothing for /skill:tdd without a normal install of tdd", async () => {
		const harness = await startSession();

		const input = await modelInput(harness, "/skill:tdd");

		expect(input).not.toContain(JSON.stringify(pinnedSkill("tdd").body).slice(1, 200));
		expect(input).not.toContain('<skill name=\\"tdd\\"');
	});

	it("injects the bundled tdd text even when the user installed a different tdd and apm updated .agents/skills", async () => {
		const harness = await startSession(({ agentDir, cwd }) => {
			writeSkill(join(agentDir, "skills"), "tdd", "USER TDD BODY");
			writeSkill(join(cwd, ".agents", "skills"), "tdd", "APM UPDATED TDD BODY");
		});

		const input = await modelInput(harness, "PLAN HANDOFF\nRun the approved schedule.");

		expect(input).toContain(JSON.stringify(pinnedSkill("tdd").body).slice(1, -1));
		expect(input).not.toContain("USER TDD BODY");
		expect(input).not.toContain("APM UPDATED TDD BODY");
	});
});
