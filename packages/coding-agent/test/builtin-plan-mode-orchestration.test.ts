import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeInTracker, type Finding, Orchestrator } from "../src/extensions/plan-mode/orchestration.ts";
import { publishTickets } from "../src/extensions/plan-mode/tickets.ts";
import { fakeBd } from "./builtin-plan-mode-fake-bd.ts";
import { setupPlanMode } from "./builtin-plan-mode-harness.ts";

// BDD contract for battlestar-pi-tkl.3: delegate implementation, verify tickets, resolve stuck work.
//
// Module under test: src/extensions/plan-mode/orchestration.ts
//   new Orchestrator(tickets: { id: string; blockedBy: string[] }[])
//     ids in blockedBy that are not in `tickets` count as already closed
//     status(id): "pending" | "contracted" | "implementing" | "verifying" | "fixing" | "framing"
//                 | "arbitrating" | "awaiting_user" | "verified" | "closed"
//     ready(): string[]               pending tickets whose blockers are all closed (no red contract needed yet)
//     recordRedContract(id, { testPath, acceptance })   throws /blocked/ if blockers are open; -> "contracted"
//     dispatchable(): string[]        contracted tickets whose blockers are all closed and that are not paused
//     dispatch(id)                    throws /blocked/ or /contract|red/ ; -> "implementing"
//     requestHelp(id): { granted: boolean; remaining: number }     at most 2 grants per ticket
//     submitWork(id)                  -> "verifying"
//     recordReview(id, findings: Finding[]): Decision
//     recordFramingOutcome(id, { agreed, pathway?, concern? }): Decision
//     recordArbitration(id, { decision, userDecision? }): Decision
//     close(id)                       throws /verif/ unless status is "verified"; -> "closed"
//     pausedWork(): string[]          awaiting_user tickets plus every ticket transitively blocked by them
//     toJSON() / Orchestrator.fromJSON(json)
//   Finding = { severity: "low" | "medium" | "high"; message: string }
//   Decision = { action: "close" | "fix" | "joint_framing" | "arbitrate" | "pause_for_user" | "resume"; ... }
//   closeInTracker(exec, tracker, id): Promise<void>   tracker = { kind: "beads", root } | { kind: "markdown", dir }
// Tool: orchestrate { action, ticketId?, ... } wires the above for the agent.

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "plan-orch-"));
	tmpDirs.push(dir);
	return dir;
}

const BLOCKING: Finding[] = [{ severity: "medium", message: "missing null check" }];
const MINOR: Finding[] = [{ severity: "low", message: "naming nit" }];
const contract = { testPath: "test/x.test.ts", acceptance: "Given x, when y, then z" };

function readyToWork(o: Orchestrator, id: string) {
	o.recordRedContract(id, contract);
	o.dispatch(id);
}

function stuck(o: Orchestrator, id: string) {
	readyToWork(o, id);
	o.submitWork(id);
	o.recordReview(id, BLOCKING); // fix cycle 1
	o.submitWork(id);
	o.recordReview(id, BLOCKING); // fix cycle 2
	o.submitWork(id);
	return o.recordReview(id, BLOCKING); // ordinary cycles exhausted
}

describe("dispatching", () => {
	it("requires the orchestrator's failing BDD contract before an implementor gets the ticket", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);

		expect(() => o.dispatch("a")).toThrow(/contract|red/i);
		o.recordRedContract("a", contract);
		o.dispatch("a");

		expect(o.status("a")).toBe("implementing");
	});

	it("never dispatches a ticket with incomplete blockers, and unlocks it when they close", () => {
		const o = new Orchestrator([
			{ id: "a", blockedBy: [] },
			{ id: "b", blockedBy: ["a"] },
		]);

		expect(o.ready()).toEqual(["a"]);
		expect(() => o.recordRedContract("b", contract)).toThrow(/blocked/i);
		expect(() => o.dispatch("b")).toThrow(/blocked/i);

		readyToWork(o, "a");
		o.submitWork("a");
		o.recordReview("a", []);
		o.close("a");

		expect(o.ready()).toEqual(["b"]);
		readyToWork(o, "b");
		expect(o.status("b")).toBe("implementing");
	});

	it("allows independent ready tickets to be dispatched in parallel", () => {
		const o = new Orchestrator([
			{ id: "a", blockedBy: [] },
			{ id: "b", blockedBy: [] },
			{ id: "c", blockedBy: ["a"] },
		]);

		o.recordRedContract("a", contract);
		o.recordRedContract("b", contract);

		expect([...o.dispatchable()].sort()).toEqual(["a", "b"]);
		o.dispatch("a");
		o.dispatch("b");
		expect([o.status("a"), o.status("b")]).toEqual(["implementing", "implementing"]);
	});

	it("treats blockers outside the ticket list as already closed", () => {
		const o = new Orchestrator([{ id: "b", blockedBy: ["long-closed"] }]);

		expect(o.ready()).toEqual(["b"]);
	});
});

describe("help requests", () => {
	it("grants at most two orchestrator-help requests per ticket", () => {
		const o = new Orchestrator([
			{ id: "a", blockedBy: [] },
			{ id: "b", blockedBy: [] },
		]);
		readyToWork(o, "a");
		readyToWork(o, "b");

		expect(o.requestHelp("a")).toEqual({ granted: true, remaining: 1 });
		expect(o.requestHelp("a")).toEqual({ granted: true, remaining: 0 });
		expect(o.requestHelp("a")).toMatchObject({ granted: false, remaining: 0 });
		expect(o.requestHelp("b").granted).toBe(true); // budget is per ticket
	});
});

describe("verification and ordinary review/fix cycles", () => {
	it("verifies clean or low-severity-only work, which can then be closed", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		readyToWork(o, "a");
		o.submitWork("a");

		expect(o.recordReview("a", MINOR).action).toBe("close");
		expect(o.status("a")).toBe("verified");
		o.close("a");
		expect(o.status("a")).toBe("closed");
	});

	it("will not close unverified work", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		readyToWork(o, "a");

		expect(() => o.close("a")).toThrow(/verif/i);
		o.submitWork("a");
		o.recordReview("a", BLOCKING);
		expect(() => o.close("a")).toThrow(/verif/i);
	});

	it("sends medium/high findings back for a fix, at most two ordinary cycles", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		readyToWork(o, "a");
		o.submitWork("a");

		const first = o.recordReview("a", BLOCKING);
		expect(first).toMatchObject({ action: "fix", cycle: 1 });
		expect(o.status("a")).toBe("fixing");
		o.submitWork("a");
		expect(o.recordReview("a", [{ severity: "high", message: "data loss" }])).toMatchObject({
			action: "fix",
			cycle: 2,
		});
		o.submitWork("a");

		expect(o.recordReview("a", BLOCKING).action).toBe("joint_framing");
		expect(o.status("a")).toBe("framing");
	});

	it("can still verify and close during a fix cycle", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		readyToWork(o, "a");
		o.submitWork("a");
		o.recordReview("a", BLOCKING);
		o.submitWork("a");

		expect(o.recordReview("a", []).action).toBe("close");
		o.close("a");
		expect(o.status("a")).toBe("closed");
	});
});

describe("joint framing and arbitration", () => {
	it("points the joint framing at the repository artifact", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);

		const decision = stuck(o, "a");

		expect(decision).toMatchObject({ action: "joint_framing", file: "docs/planning_support_docs/joint-framing.md" });
	});

	it("grants exactly one more work/review cycle when a pathway is agreed", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		stuck(o, "a");

		const framed = o.recordFramingOutcome("a", { agreed: true, pathway: "use approach B" });
		expect(framed).toMatchObject({ action: "fix", extra: true });
		expect(o.status("a")).toBe("fixing");
		o.submitWork("a");

		expect(o.recordReview("a", BLOCKING).action).toBe("arbitrate");
	});

	it.each(["destructive-data", "security"] as const)(
		"still pauses for the user when the extra cycle fails and framing recorded a %s concern",
		(concern) => {
			const o = new Orchestrator([
				{ id: "a", blockedBy: [] },
				{ id: "b", blockedBy: ["a"] },
			]);
			stuck(o, "a");
			o.recordFramingOutcome("a", { agreed: true, pathway: "use approach B", concern });
			o.submitWork("a");

			const decision = o.recordReview("a", BLOCKING);

			expect(decision).toMatchObject({ action: "arbitrate", reasoning: "medium", askUser: true });
			expect(o.status("a")).toBe("awaiting_user");
			expect([...o.pausedWork()].sort()).toEqual(["a", "b"]);
			expect(o.recordArbitration("a", { decision: "x", userDecision: "keep the data" }).action).toBe("resume");
		},
	);

	it("leaves the ticket untouched when an agreed framing is rejected for lacking a pathway", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		stuck(o, "a");
		const before = JSON.stringify(o.toJSON());

		expect(() => o.recordFramingOutcome("a", { agreed: true, pathway: " ", concern: "security" })).toThrow(
			/pathway/i,
		);

		expect(JSON.stringify(o.toJSON())).toBe(before);
	});

	it("keeps the concern across a JSON round trip", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		stuck(o, "a");
		o.recordFramingOutcome("a", { agreed: true, pathway: "use approach B", concern: "security" });
		o.submitWork("a");
		const copy = Orchestrator.fromJSON(JSON.parse(JSON.stringify(o.toJSON())));

		expect(copy.recordReview("a", BLOCKING)).toMatchObject({ action: "arbitrate", askUser: true });
	});

	it("closes after the extra cycle when the agreed pathway works", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		stuck(o, "a");
		o.recordFramingOutcome("a", { agreed: true, pathway: "use approach B" });
		o.submitWork("a");

		expect(o.recordReview("a", []).action).toBe("close");
	});

	it("goes to a medium-reasoning arbitrator when no pathway is agreed", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		stuck(o, "a");

		const decision = o.recordFramingOutcome("a", { agreed: false, concern: "none" });

		expect(decision).toMatchObject({ action: "arbitrate", reasoning: "medium", askUser: false });
		expect(o.status("a")).toBe("arbitrating");
		expect(o.recordArbitration("a", { decision: "go with option A" }).action).toBe("fix");
		expect(o.status("a")).toBe("implementing");
	});

	it.each(["destructive-data", "security"] as const)(
		"pauses for the user on a %s concern, via the arbitrator",
		(concern) => {
			const o = new Orchestrator([
				{ id: "a", blockedBy: [] },
				{ id: "b", blockedBy: ["a"] },
				{ id: "c", blockedBy: ["b"] },
				{ id: "free", blockedBy: [] },
			]);
			stuck(o, "a");

			const decision = o.recordFramingOutcome("a", { agreed: false, concern });

			expect(decision).toMatchObject({ action: "arbitrate", reasoning: "medium", askUser: true });
			expect(o.status("a")).toBe("awaiting_user");
			expect([...o.pausedWork()].sort()).toEqual(["a", "b", "c"]); // unrelated "free" keeps going
			expect(() => o.close("a")).toThrow();
			expect(() => o.dispatch("a")).toThrow(/paused|awaiting|user/i);
			expect(o.ready()).toContain("free");
			expect(o.ready()).not.toContain("a");

			expect(() => o.recordArbitration("a", { decision: "arbitrator guess" })).toThrow(/user/i);
			expect(o.recordArbitration("a", { decision: "keep the data", userDecision: "do not delete" }).action).toBe(
				"resume",
			);
			expect(o.pausedWork()).toEqual([]);
			expect(o.status("a")).toBe("implementing");
		},
	);

	it("pauses for the user rather than looping when arbitrated work still fails review", () => {
		const o = new Orchestrator([{ id: "a", blockedBy: [] }]);
		stuck(o, "a");
		o.recordFramingOutcome("a", { agreed: false, concern: "none" });
		o.recordArbitration("a", { decision: "option A" });
		o.submitWork("a");

		expect(o.recordReview("a", BLOCKING).action).toBe("pause_for_user");
		expect(o.status("a")).toBe("awaiting_user");
	});
});

describe("persistence and tracker closure", () => {
	it("round-trips through JSON without losing counters", () => {
		const o = new Orchestrator([
			{ id: "a", blockedBy: [] },
			{ id: "b", blockedBy: ["a"] },
		]);
		readyToWork(o, "a");
		o.requestHelp("a");
		o.requestHelp("a");
		o.submitWork("a");
		o.recordReview("a", BLOCKING);

		const copy = Orchestrator.fromJSON(JSON.parse(JSON.stringify(o.toJSON())));

		expect(copy.status("a")).toBe("fixing");
		expect(copy.requestHelp("a").granted).toBe(false);
		copy.submitWork("a");
		expect(copy.recordReview("a", BLOCKING)).toMatchObject({ action: "fix", cycle: 2 });
	});

	it("closes a Beads ticket with bd close, and surfaces failures", async () => {
		const bd = fakeBd();
		const published = await publishTickets({
			exec: bd.exec,
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
			markdownDir: tmp(),
		});
		const id = published.ticketIds.a!;

		await closeInTracker(bd.exec, { kind: "beads", root: "/repo" }, id);

		expect(bd.issues.get(id)?.status).toBe("closed");
		await expect(closeInTracker(bd.exec, { kind: "beads", root: "/repo" }, "nope")).rejects.toThrow();
	});

	it("marks a Markdown ticket complete", async () => {
		const dir = tmp();
		await publishTickets({
			exec: fakeBd({ usable: false }).exec,
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
			markdownDir: dir,
		});
		const file = readdirSync(dir).find((f) => !/readme|index/i.test(f))!;
		const id = String(/^ID: (\S+)$/m.exec(readFileSync(join(dir, file), "utf8"))?.[1]);

		await closeInTracker(fakeBd().exec, { kind: "markdown", dir }, id);

		expect(readFileSync(join(dir, `${id}.md`), "utf8")).toMatch(/^Status: closed$/m);
	});
});

describe("orchestrate tool", () => {
	const tickets = [
		{ id: "a", blockedBy: [] },
		{ id: "b", blockedBy: ["a"] },
	];

	async function orchestrating() {
		const bd = fakeBd();
		bd.issues.set("a", { title: "Title a", status: "open" });
		const h = setupPlanMode({ exec: bd.exec });
		await h.runTool("orchestrate", { action: "init", tickets, tracker: { kind: "beads", root: "/repo" } });
		return { h, bd };
	}

	it("enforces the dispatch rules and reports what is ready", async () => {
		const { h } = await orchestrating();

		await expect(h.runTool("orchestrate", { action: "dispatch", ticketId: "a" })).rejects.toThrow(/contract|red/i);
		await h.runTool("orchestrate", { action: "red_contract", ticketId: "a", ...contract });
		const dispatched = await h.runTool("orchestrate", { action: "dispatch", ticketId: "a" });

		expect(dispatched.details?.status).toBe("implementing");
		await expect(h.runTool("orchestrate", { action: "dispatch", ticketId: "b" })).rejects.toThrow(/blocked/i);
	});

	it("walks review findings to joint framing and arbitration, naming the artifacts to use", async () => {
		const { h } = await orchestrating();
		await h.runTool("orchestrate", { action: "red_contract", ticketId: "a", ...contract });
		await h.runTool("orchestrate", { action: "dispatch", ticketId: "a" });
		let last = await h.runTool("orchestrate", { action: "review", ticketId: "a", findings: BLOCKING });
		for (let i = 0; i < 2; i++) {
			await h.runTool("orchestrate", { action: "submit_work", ticketId: "a" });
			last = await h.runTool("orchestrate", { action: "review", ticketId: "a", findings: BLOCKING });
		}
		const framingText = last.content.map((c) => c.text ?? "").join("\n");
		expect(last.details?.status).toBe("framing");
		expect(framingText).toContain("docs/planning_support_docs/joint-framing.md");

		const arbitrate = await h.runTool("orchestrate", {
			action: "framing",
			ticketId: "a",
			agreed: false,
			concern: "security",
		});
		const arbText = arbitrate.content.map((c) => c.text ?? "").join("\n");
		expect(arbText).toMatch(/medium/i);
		expect(arbText).toContain("docs/escalation");
		expect(arbText).toMatch(/user/i);
		expect(arbitrate.details?.status).toBe("awaiting_user");
	});

	it("tells the agent to ask the user when an agreed pathway fails under a security concern", async () => {
		const { h } = await orchestrating();
		await h.runTool("orchestrate", { action: "red_contract", ticketId: "a", ...contract });
		await h.runTool("orchestrate", { action: "dispatch", ticketId: "a" });
		await h.runTool("orchestrate", { action: "review", ticketId: "a", findings: BLOCKING });
		for (let i = 0; i < 2; i++) {
			await h.runTool("orchestrate", { action: "submit_work", ticketId: "a" });
			await h.runTool("orchestrate", { action: "review", ticketId: "a", findings: BLOCKING });
		}
		await h.runTool("orchestrate", {
			action: "framing",
			ticketId: "a",
			agreed: true,
			pathway: "use B",
			concern: "security",
		});
		await h.runTool("orchestrate", { action: "submit_work", ticketId: "a" });

		const result = await h.runTool("orchestrate", { action: "review", ticketId: "a", findings: BLOCKING });

		expect(result.details?.status).toBe("awaiting_user");
		expect(result.content.map((c) => c.text ?? "").join("\n")).toMatch(/user/i);
	});

	it("closes a verified ticket in the tracker, which unblocks its dependents", async () => {
		const { h, bd } = await orchestrating();
		await h.runTool("orchestrate", { action: "red_contract", ticketId: "a", ...contract });
		await h.runTool("orchestrate", { action: "dispatch", ticketId: "a" });
		await h.runTool("orchestrate", { action: "review", ticketId: "a", findings: [] });

		const closed = await h.runTool("orchestrate", { action: "close", ticketId: "a" });

		expect(bd.issues.get("a")?.status).toBe("closed");
		expect(closed.details?.ready).toEqual(["b"]);
	});

	it("keeps orchestration rules in the agent's context and survives a resume", async () => {
		const { h } = await orchestrating();

		const context = await h.injectedContext();
		expect(context).toContain("docs/planning_support_docs/joint-framing.md");

		const resumed = setupPlanMode({ entries: h.entries });
		await resumed.emit("session_start", {});
		expect(await resumed.injectedContext()).toContain("joint-framing.md");
		const status = await resumed.runTool("orchestrate", { action: "status" });
		expect(status.details?.ready).toEqual(["a"]);
	});
});
