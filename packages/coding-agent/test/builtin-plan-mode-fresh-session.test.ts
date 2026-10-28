import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeBd } from "./builtin-plan-mode-fake-bd.ts";
import { type PlanHarness, setupPlanMode } from "./builtin-plan-mode-harness.ts";

// BDD contract for battlestar-pi-oev.4: the fresh session after /plan-execute is in normal mode with write tools,
// even when the harness was started in plan mode with --plan.

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function readyToHandOff(options: Parameters<typeof setupPlanMode>[0] = {}): Promise<PlanHarness> {
	const cwd = mkdtempSync(join(tmpdir(), "plan-fresh-session-"));
	tmpDirs.push(cwd);
	const h = setupPlanMode({ cwd, exec: fakeBd().exec, ...options });
	await h.emit("session_start", { reason: "startup" });
	if (h.activeTools().includes("write")) await h.runCommand("plan", "build the thing");
	await h.runTool("plan_confirm", { kind: "outcome", summary: "o" });
	await h.runTool("plan_confirm", { kind: "system_model", summary: "s" });
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

describe("the fresh session after /plan-execute", () => {
	it.each([
		["started with /plan", {}],
		["started in plan mode with --plan", { flags: { plan: true } }],
	])("starts in normal mode with write tools when the harness was %s", async (_label, options) => {
		const h = await readyToHandOff(options);
		expect(h.activeTools()).not.toContain("write");

		await h.runCommand("plan-execute");
		await h.emit("session_start", { reason: "new" });

		expect(h.activeTools()).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(h.lastStatus()).toBeUndefined();
	});
});
