import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildHandoff,
	deriveSchedule,
	readBeadsIssues,
	readMarkdownIssues,
	renderSchedule,
	type TrackerIssue,
} from "../src/extensions/plan-mode/schedule.ts";
import { type DraftTicket, publishTickets } from "../src/extensions/plan-mode/tickets.ts";
import { fakeBd } from "./plan-mode-fake-bd.ts";
import { type PlanHarness, setupPlanMode } from "./plan-mode-harness.ts";

// BDD contract for battlestar-pi-tkl.4: tracker-derived schedule, user agreement, /handoff + /new.
//
// Module under test: src/extensions/plan-mode/schedule.ts
//   deriveSchedule(issues: TrackerIssue[]): Schedule
//     Schedule = { waves: { index: number; ticketIds: string[]; parallel: boolean }[]; ready: string[] }
//     closed issues are excluded (and satisfy blockers); wave 0 === ready now; unknown blocker or cycle throws
//   renderSchedule(schedule, issues): string          human-readable ordering with ids + titles + parallel marks
//   readBeadsIssues(exec, epicId): Promise<TrackerIssue[]>   from `bd list --parent <epic> --all --json`
//   readMarkdownIssues(dir): TrackerIssue[]           reads the Markdown tracker format pinned in plan-mode-ticketing.test.ts
//   buildHandoff({ schedule, issues, tracker, request }): string
//   TrackerIssue = { id: string; title: string; status: string; blockedBy: string[] }
// Tools: plan_schedule { action: "propose" | "agree", epicId?, markdownDir? }
// Command: /plan-execute (handoff + new session)

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "plan-handoff-"));
	tmpDirs.push(dir);
	return dir;
}

function issue(id: string, blockedBy: string[] = [], status = "open"): TrackerIssue {
	return { id, title: `Title ${id}`, status, blockedBy };
}

describe("deriving the schedule from tracker statuses and edges", () => {
	it("orders waves by blockers and marks independent tickets as parallel", () => {
		const schedule = deriveSchedule([
			issue("d", ["b", "c"]),
			issue("b", ["a"]),
			issue("c", ["a"]),
			issue("a"),
			issue("e"),
		]);

		expect(schedule.waves.map((w) => [...w.ticketIds].sort())).toEqual([["a", "e"], ["b", "c"], ["d"]]);
		expect(schedule.waves.map((w) => w.parallel)).toEqual([true, true, false]);
		expect([...schedule.ready].sort()).toEqual(["a", "e"]);
	});

	it("treats closed tickets as satisfied blockers and leaves them out", () => {
		const schedule = deriveSchedule([issue("a", [], "closed"), issue("b", ["a"]), issue("c", ["b"])]);

		expect(schedule.ready).toEqual(["b"]);
		expect(schedule.waves.map((w) => w.ticketIds)).toEqual([["b"], ["c"]]);
	});

	it("fails on dependency cycles and on blockers missing from the tracker", () => {
		expect(() => deriveSchedule([issue("a", ["b"]), issue("b", ["a"])])).toThrow(/cycle/i);
		expect(() => deriveSchedule([issue("a", ["ghost"])])).toThrow(/ghost/);
	});

	it("renders ordering, ids, titles, and which tickets run in parallel", () => {
		const issues = [issue("a"), issue("b"), issue("c", ["a", "b"])];

		const text = renderSchedule(deriveSchedule(issues), issues);

		for (const id of ["a", "b", "c"]) expect(text).toContain(`Title ${id}`);
		expect(text).toMatch(/parallel/i);
		expect(text.indexOf("Title c")).toBeGreaterThan(text.indexOf("Title a"));
	});
});

describe("reading the tracker", () => {
	it("reads Beads issues, using only blocking edges as blockers (not parent-child)", async () => {
		const bd = fakeBd();
		const drafts: DraftTicket[] = ["a", "b"].map((key, i) => ({
			key,
			title: `Title ${key}`,
			whatToBuild: key,
			acceptance: [`Given ${key}, when x, then y`],
			blockedBy: i === 1 ? ["a"] : [],
			skills: [{ name: "tdd", guidance: "g" }],
		}));
		const published = await publishTickets({
			exec: bd.exec,
			epic: { title: "E", outcome: "O" },
			drafts,
			markdownDir: tmp(),
		});

		const issues = await readBeadsIssues(bd.exec, published.epicId);

		const byTitle = new Map(issues.map((i) => [i.title, i]));
		expect(issues).toHaveLength(2);
		expect(byTitle.get("Title b")?.blockedBy).toEqual([byTitle.get("Title a")?.id]);
		expect(byTitle.get("Title a")?.blockedBy).toEqual([]);
		expect(byTitle.get("Title a")?.status).toBe("open");
	});

	it("reads the Markdown tracker written by the Markdown fallback", async () => {
		const dir = tmp();
		const drafts: DraftTicket[] = [
			{
				key: "a",
				title: "Title a",
				whatToBuild: "a",
				acceptance: ["Given a, when x, then y"],
				blockedBy: [],
				skills: [{ name: "tdd", guidance: "g" }],
			},
			{
				key: "b",
				title: "Title b",
				whatToBuild: "b",
				acceptance: ["Given b, when x, then y"],
				blockedBy: ["a"],
				skills: [{ name: "tdd", guidance: "g" }],
			},
		];
		await publishTickets({
			exec: fakeBd({ usable: false }).exec,
			epic: { title: "E", outcome: "O" },
			drafts,
			markdownDir: dir,
		});

		const issues = readMarkdownIssues(dir);

		const byTitle = new Map(issues.map((i) => [i.title, i]));
		expect(byTitle.get("Title b")?.blockedBy).toEqual([byTitle.get("Title a")?.id]);
		expect(byTitle.get("Title a")?.status).toBe("open");
	});
});

describe("the handoff document", () => {
	it("carries the approved schedule, ticket references, tracker location, and no second approval request", () => {
		const issues = [issue("a"), issue("b", ["a"])];

		const text = buildHandoff({
			schedule: deriveSchedule(issues),
			issues,
			tracker: { kind: "beads", epicId: "epic-9" },
			request: "build the thing",
		});

		for (const needle of ["a", "b", "Title a", "Title b", "epic-9", "build the thing"])
			expect(text).toContain(needle);
		expect(text).toMatch(/already approved|approved schedule/i);
		expect(text).not.toMatch(/ask the user to approve/i);
	});
});

describe("agreeing the schedule and executing", () => {
	async function scheduling(
		options: Parameters<typeof setupPlanMode>[0] = {},
	): Promise<PlanHarness & { epicId: string }> {
		const bd = fakeBd();
		const h = setupPlanMode({ cwd: tmp(), exec: bd.exec, ...options });
		await h.runCommand("plan", "build the thing");
		await h.runTool("plan_confirm", { kind: "outcome", summary: "o" });
		await h.runTool("plan_confirm", { kind: "system_model", summary: "s" });
		await h.runTool("plan_phase", { phase: "ticketing" });
		const draft = (key: string, blockedBy: string[]) => ({
			key,
			title: `Title ${key}`,
			whatToBuild: key,
			acceptance: [`Given ${key}, when x, then y`],
			blockedBy,
			skills: [{ name: "tdd", guidance: "g" }],
		});
		await h.runTool("plan_tickets", {
			action: "submit_drafts",
			epic: { title: "E", outcome: "O" },
			drafts: [draft("a", []), draft("b", ["a"]), draft("c", [])],
		});
		await h.runTool("plan_tickets", { action: "approve" });
		const published = await h.runTool("plan_tickets", { action: "publish" });
		return Object.assign(h, { epicId: String(published.details?.epicId) });
	}

	it("proposes a schedule read from the tracker: ready work, ordering, safe parallelism", async () => {
		const h = await scheduling();

		const result = await h.runTool("plan_schedule", { action: "propose" });

		const text = result.content.map((c) => c.text ?? "").join("\n");
		expect(text).toContain("Title a");
		expect(text).toContain("Title b");
		expect(text).toMatch(/parallel/i);
		expect(result.details?.phase).toBe("scheduling");
		expect(result.details?.agreed).toBe(false);
	});

	it("refuses to agree before a proposal, and keeps the plan in scheduling when the user declines", async () => {
		const h = await scheduling();
		await expect(h.runTool("plan_schedule", { action: "agree" })).rejects.toThrow(/propos/i);

		await h.runTool("plan_schedule", { action: "propose" });
		h.confirm.mockImplementationOnce(async () => false);
		const result = await h.runTool("plan_schedule", { action: "agree" });

		expect(result.details?.agreed).toBe(false);
		expect(result.details?.phase).toBe("scheduling");
	});

	it("makes Execute available only after the user agrees", async () => {
		const h = await scheduling({ select: (_t, options) => options.find((o) => /execute/i.test(o)) });
		await h.runTool("plan_schedule", { action: "propose" });
		await h.triggerAgentEnd("here is the schedule");
		expect(h.select).not.toHaveBeenCalled();

		await h.runTool("plan_schedule", { action: "agree" });
		const agreed = await h.runTool("plan_schedule", { action: "propose" }); // re-proposing revokes agreement
		expect(agreed.details?.agreed).toBe(false);
		await h.runTool("plan_schedule", { action: "agree" });
		await h.triggerAgentEnd("agreed");

		expect(h.select).toHaveBeenCalledTimes(1);
	});

	it("exits plan mode, starts a fresh session from the parent, and begins orchestration with the approved schedule", async () => {
		const h = await scheduling();
		await h.runTool("plan_schedule", { action: "propose" });
		await h.runTool("plan_schedule", { action: "agree" });
		let toolsWhenNewSessionStarted: string[] = [];
		h.newSession.mockImplementationOnce(async (opts) => {
			toolsWhenNewSessionStarted = h.activeTools();
			await opts?.withSession?.({ ui: h.ctx.ui, sendUserMessage: h.replacementSendUserMessage });
			return { cancelled: false };
		});

		await h.runCommand("plan-execute");

		expect(toolsWhenNewSessionStarted).toEqual(expect.arrayContaining(["edit", "write"])); // plan mode already exited
		expect(h.newSession).toHaveBeenCalledTimes(1);
		expect(h.newSession.mock.calls[0]![0]).toMatchObject({ parentSession: "/tmp/parent-session.jsonl" });
		expect(h.replacementSendUserMessage).toHaveBeenCalledTimes(1);
		const handoff = String(h.replacementSendUserMessage.mock.calls[0]![0]);
		expect(handoff).toContain(h.epicId);
		for (const title of ["Title a", "Title b", "Title c"]) expect(handoff).toContain(title);
		expect(handoff).toMatch(/already approved|approved schedule/i);
		expect(h.appendEntry).toHaveBeenCalledWith("plan-mode", expect.objectContaining({ enabled: false }));
	});

	it("pauses with a manual-action message when /handoff is unavailable", async () => {
		const h = await scheduling({ slashCommands: [] });
		await h.runTool("plan_schedule", { action: "propose" });
		await h.runTool("plan_schedule", { action: "agree" });

		await h.runCommand("plan-execute");

		expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/\/handoff/), "error");
		expect(h.newSession).not.toHaveBeenCalled();
		expect(h.activeTools()).not.toContain("write"); // still planning, nothing lost
	});

	it("pauses with a manual-action message when /new is unavailable", async () => {
		const h = await scheduling({ hasNewSession: false });
		await h.runTool("plan_schedule", { action: "propose" });
		await h.runTool("plan_schedule", { action: "agree" });

		await h.runCommand("plan-execute");

		expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/\/new/), "error");
		expect(h.activeTools()).not.toContain("write");
	});

	it("refuses to execute while the schedule is not agreed", async () => {
		const h = await scheduling();

		await h.runCommand("plan-execute");

		expect(h.newSession).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/schedule|agree/i), "error");
	});
});
