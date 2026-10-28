import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fakeBd } from "./builtin-plan-mode-fake-bd.ts";
import { type PlanHarness, setupPlanMode } from "./builtin-plan-mode-harness.ts";

// BDD contract for battlestar-pi-oev.3: plan mode injects the pinned core skills (ADR 0002) per phase.
// The pinned copy lives in packages/coding-agent/core-skills/<name>/ and is refreshed only by
// scripts/sync-core-skills.mjs. Plan mode injects each SKILL.md body verbatim.

const CORE_SKILLS_DIR = fileURLToPath(new URL("../core-skills/", import.meta.url));

/** The pinned SKILL.md body (frontmatter removed), as plan mode must inject it. */
function pinnedBody(name: string): string {
	const text = readFileSync(join(CORE_SKILLS_DIR, name, "SKILL.md"), "utf8");
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

const GRILLING_SKILLS = ["grill-with-docs", "grilling", "domain-modeling"];
const ORCHESTRATION_SKILLS = ["tdd", "code-review", "diagnosing-bugs", "codebase-design", "beads"];

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function choose(pattern: RegExp) {
	return (_title: string, options: string[]) => options.find((o) => pattern.test(o));
}

async function inGrilling(): Promise<PlanHarness> {
	const h = setupPlanMode({ select: choose(/grill/i) });
	await h.runCommand("plan", "build the thing");
	await h.runTool("plan_readiness", { recommendation: "grill", rationale: "unclear" });
	return h;
}

async function confirmBoth(h: PlanHarness): Promise<void> {
	await h.runTool("plan_confirm", { kind: "outcome", summary: "o" });
	await h.runTool("plan_confirm", { kind: "system_model", summary: "s" });
}

/** Plan mode with published tickets and an agreed schedule, ready to hand off. */
async function readyToHandOff(options: Parameters<typeof setupPlanMode>[0] = {}): Promise<PlanHarness> {
	const cwd = mkdtempSync(join(tmpdir(), "plan-core-skills-"));
	tmpDirs.push(cwd);
	const h = setupPlanMode({ cwd, exec: fakeBd().exec, ...options });
	await h.runCommand("plan", "build the thing");
	await confirmBoth(h);
	await h.runTool("plan_phase", { phase: "ticketing" });
	await h.runTool("plan_tickets", {
		action: "submit_drafts",
		epic: { title: "E", outcome: "O" },
		drafts: [
			{
				key: "a",
				title: "Title a",
				whatToBuild: "a",
				acceptance: ["Given a, when x, then y"],
				blockedBy: [],
				skills: [{ name: "tdd", guidance: "g" }],
			},
		],
	});
	await h.runTool("plan_tickets", { action: "approve" });
	await h.runTool("plan_tickets", { action: "publish" });
	await h.runTool("plan_schedule", { action: "propose" });
	await h.runTool("plan_schedule", { action: "agree" });
	return h;
}

async function orchestrationContext(h: PlanHarness): Promise<string> {
	const results = await h.emit("before_agent_start", { messageType: "user", prompt: "PLAN HANDOFF\nrun the tickets" });
	return results.map((r) => (r as { message?: { content?: string } } | undefined)?.message?.content ?? "").join("\n");
}

describe("plan mode injects its pinned core skills per phase", () => {
	it("carries grill-with-docs, grilling, and domain-modeling while grilling", async () => {
		const h = await inGrilling();

		const context = await h.injectedContext();

		for (const name of GRILLING_SKILLS) expect(context).toContain(pinnedBody(name));
		expect(context).not.toContain(pinnedBody("to-tickets"));
	});

	it("carries to-tickets while ticketing", async () => {
		const h = setupPlanMode();
		await h.runCommand("plan", "build the thing");
		await confirmBoth(h);
		await h.runTool("plan_phase", { phase: "ticketing" });

		const context = await h.injectedContext();

		expect(context).toContain(pinnedBody("to-tickets"));
		expect(context).not.toContain(pinnedBody("grill-with-docs"));
	});

	it("carries handoff once the schedule is agreed", async () => {
		const h = await readyToHandOff();

		expect(await h.injectedContext()).toContain(pinnedBody("handoff"));
	});

	it("carries tdd, code-review, diagnosing-bugs, codebase-design, and beads in the orchestration session", async () => {
		const h = setupPlanMode();

		const context = await orchestrationContext(h);

		for (const name of ORCHESTRATION_SKILLS) expect(context).toContain(pinnedBody(name));
		expect(context).not.toContain(pinnedBody("grilling"));
	});

	it("never points the agent at /skill: commands, which do not exist for core skills", async () => {
		const grilling = await inGrilling();
		const ticketing = setupPlanMode();
		await ticketing.runCommand("plan", "build the thing");
		await confirmBoth(ticketing);
		await ticketing.runTool("plan_phase", { phase: "ticketing" });

		for (const context of [
			await grilling.injectedContext(),
			await ticketing.injectedContext(),
			await orchestrationContext(setupPlanMode()),
		]) {
			expect(context).not.toContain("/skill:");
		}
	});

	it("hands off with the bundled handoff skill when no /handoff command is installed", async () => {
		const h = await readyToHandOff({ slashCommands: [] });

		await h.runCommand("plan-execute");

		expect(h.newSession).toHaveBeenCalledTimes(1);
	});
});
