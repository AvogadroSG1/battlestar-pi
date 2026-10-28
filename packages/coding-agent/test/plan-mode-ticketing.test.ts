import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type DraftTicket,
	orderForPublication,
	publishTickets,
	renderTicketBody,
	validateDrafts,
} from "../examples/extensions/plan-mode/tickets.ts";
import { fakeBd } from "./plan-mode-fake-bd.ts";
import { type PlanHarness, setupPlanMode } from "./plan-mode-harness.ts";

// BDD contract for battlestar-pi-tkl.5: draft, review, and publish dependency-aware tickets.
//
// Module under test: examples/extensions/plan-mode/tickets.ts
//   validateDrafts(drafts): string[]                 problems; [] means valid
//   orderForPublication(drafts): DraftTicket[]       blockers first, stable otherwise
//   renderTicketBody(ticket, blockerTitles): string  markdown body
//   publishTickets({ exec, epic, drafts, markdownDir }): Promise<PublishResult>
// Tool: plan_tickets { action: "submit_drafts" | "approve" | "publish", epic?, drafts? }

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "plan-tickets-"));
	tmpDirs.push(dir);
	return dir;
}

function draft(key: string, overrides: Partial<DraftTicket> = {}): DraftTicket {
	return {
		key,
		title: `Title ${key}`,
		whatToBuild: `Build ${key} end to end`,
		acceptance: [`Given ${key} exists, when the user acts, then they see the result`],
		blockedBy: [],
		skills: [{ name: "tdd", guidance: "write the behavior test first" }],
		...overrides,
	};
}

const epic = { title: "Dark mode", outcome: "Users can switch themes" };
const chain = [draft("a"), draft("b", { blockedBy: ["a"] }), draft("c", { blockedBy: ["b"] })];

describe("validating drafts", () => {
	it("accepts well-formed tracer-bullet drafts", () => {
		expect(validateDrafts(chain)).toEqual([]);
	});

	it("requires a user-observable Given/When/Then contract on every ticket", () => {
		const problems = validateDrafts([draft("a", { acceptance: ["it works"] })]);

		expect(problems.join("\n")).toMatch(/a/);
		expect(problems.join("\n")).toMatch(/given.*when.*then|BDD/i);
		expect(validateDrafts([draft("a", { acceptance: [] })]).join("\n")).toMatch(/BDD|acceptance/i);
	});

	it("requires named repository skills with loading guidance", () => {
		expect(validateDrafts([draft("a", { skills: [] })]).join("\n")).toMatch(/skill/i);
		expect(validateDrafts([draft("a", { skills: [{ name: "tdd", guidance: "  " }] })]).join("\n")).toMatch(
			/guidance/i,
		);
	});

	it("rejects unknown blockers, duplicate keys, cycles, and empty sets", () => {
		expect(validateDrafts([draft("a", { blockedBy: ["zzz"] })]).join("\n")).toMatch(/zzz/);
		expect(validateDrafts([draft("a"), draft("a")]).join("\n")).toMatch(/duplicate/i);
		const cycle = [draft("a", { blockedBy: ["b"] }), draft("b", { blockedBy: ["a"] })];
		expect(validateDrafts(cycle).join("\n")).toMatch(/cycle/i);
		expect(validateDrafts([]).length).toBeGreaterThan(0);
	});
});

describe("ordering and rendering", () => {
	it("orders blockers before dependents regardless of draft order", () => {
		const shuffled = [chain[2]!, chain[0]!, chain[1]!];

		expect(orderForPublication(shuffled).map((t) => t.key)).toEqual(["a", "b", "c"]);
	});

	it("renders the BDD contract, blockers, and skill-loading guidance into the body", () => {
		const body = renderTicketBody(chain[1]!, ["Title a"]);

		expect(body).toContain("Given b exists, when the user acts, then they see the result");
		expect(body).toMatch(/blocked by/i);
		expect(body).toContain("Title a");
		expect(body).toContain("/skill:tdd");
		expect(body).toContain("write the behavior test first");
		expect(renderTicketBody(chain[0]!, [])).toMatch(/none|can start immediately/i);
	});
});

describe("publishing to Beads", () => {
	it("creates one epic, then children under it in dependency order, with native blocker edges", async () => {
		const bd = fakeBd();

		const result = await publishTickets({
			exec: bd.exec,
			epic,
			drafts: [chain[2]!, chain[0]!, chain[1]!],
			markdownDir: tmp(),
		});

		expect(result.tracker).toBe("beads");
		const epicId = result.epicId;
		expect(bd.issues.get(epicId)?.type).toBe("epic");
		expect([...bd.issues.values()].filter((i) => i.type === "epic")).toHaveLength(1);
		const ids = result.ticketIds;
		expect(bd.order).toEqual([epicId, ids.a, ids.b, ids.c]);
		for (const key of ["a", "b", "c"]) expect(bd.issues.get(ids[key]!)?.parent).toBe(epicId);
		expect(bd.edges).toEqual(
			expect.arrayContaining([
				[ids.b, ids.a],
				[ids.c, ids.b],
			]),
		);
		expect(bd.edges).toHaveLength(2);
	});

	it("puts the contract, blocker text, and skills into each created ticket", async () => {
		const bd = fakeBd();

		const result = await publishTickets({ exec: bd.exec, epic, drafts: chain, markdownDir: tmp() });

		const b = bd.issues.get(result.ticketIds.b!)!;
		expect(b.title).toBe("Title b");
		expect(b.description).toContain("Given b exists, when the user acts, then they see the result");
		expect(b.description).toMatch(/blocked by/i);
		expect(b.description).toContain("Title a");
		expect(b.skills).toContain("tdd");
	});

	it("fails loudly, naming what was already created, if Beads breaks mid-publish", async () => {
		const bd = fakeBd({ failOnCreateNumber: 3 });

		const error = await publishTickets({ exec: bd.exec, epic, drafts: chain, markdownDir: tmp() }).then(
			() => undefined,
			(e: Error) => e,
		);

		expect(error?.message).toContain("t-1");
	});
});

describe("Markdown fallback when Beads is unusable", () => {
	it("writes an index and one file per ticket, keeping blockers explicit", async () => {
		const dir = tmp();
		const bd = fakeBd({ usable: false });

		const result = await publishTickets({
			exec: bd.exec,
			epic,
			drafts: [chain[1]!, chain[0]!, chain[2]!],
			markdownDir: dir,
		});

		expect(result.tracker).toBe("markdown");
		const files = readdirSync(dir).sort();
		expect(files).toHaveLength(4);
		const index = readFileSync(join(dir, files.find((f) => /readme|index/i.test(f))!), "utf8");
		for (const t of chain) expect(index).toContain(t.title);
		const ticketFiles = files.filter((f) => !/readme|index/i.test(f));
		const textOf = (title: string) =>
			readFileSync(
				join(dir, ticketFiles.find((f) => readFileSync(join(dir, f), "utf8").includes(`# ${title}`))!),
				"utf8",
			);
		const bText = textOf("Title b");
		expect(bText).toMatch(/blocked by/i);
		expect(bText).toContain("Title a");
		expect(bText).toContain("Given b exists, when the user acts, then they see the result");
		// Pinned tracker format (read back by schedule.ts and orchestration.ts):
		//   "# <Title>", "ID: <file name without .md>", "Status: open", "## Blocked by" with "- <blocker ID>" lines.
		const idOf = (text: string) => /^ID: (\S+)$/m.exec(text)?.[1];
		const aId = idOf(textOf("Title a"));
		expect(aId).toBeTruthy();
		expect(ticketFiles).toContain(`${aId}.md`);
		expect(bText).toMatch(/^Status: open$/m);
		expect(bText).toMatch(new RegExp(`^## Blocked by[\\s\\S]*^- ${aId}\\b`, "m"));
	});
});

describe("plan_tickets tool: review gate and publication", () => {
	async function reviewing(options: Parameters<typeof setupPlanMode>[0] = {}): Promise<PlanHarness> {
		const h = setupPlanMode({ cwd: tmp(), ...options });
		await h.runCommand("plan", "x");
		await h.runTool("plan_confirm", { kind: "outcome", summary: "o" });
		await h.runTool("plan_confirm", { kind: "system_model", summary: "s" });
		await h.runTool("plan_phase", { phase: "ticketing" });
		return h;
	}

	it("only accepts drafts while ticketing, rejects invalid drafts with the problems", async () => {
		const early = setupPlanMode({ cwd: tmp() });
		await early.runCommand("plan", "x");
		await expect(early.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain })).rejects.toThrow(
			/phase|ticketing/i,
		);

		const h = await reviewing();
		await expect(
			h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: [draft("a", { acceptance: ["nope"] })] }),
		).rejects.toThrow(/BDD|given/i);
	});

	it("moves to reviewing and prompts the agent to review granularity and dependencies with the user", async () => {
		const h = await reviewing();

		const result = await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });

		expect(result.details?.phase).toBe("reviewing");
		expect(result.details?.approved).toBe(false);
		const text = result.content.map((c) => c.text ?? "").join("\n");
		expect(text).toMatch(/granularity/i);
		expect(text).toMatch(/dependenc/i);
	});

	it("never publishes before the user approves, and revokes approval when drafts change", async () => {
		const bd = fakeBd();
		const h = await reviewing({ exec: bd.exec });
		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });

		await expect(h.runTool("plan_tickets", { action: "publish" })).rejects.toThrow(/approv/i);
		expect(bd.order).toHaveLength(0);

		await h.runTool("plan_tickets", { action: "approve" });
		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: [...chain, draft("d")] });
		await expect(h.runTool("plan_tickets", { action: "publish" })).rejects.toThrow(/approv/i);
	});

	it("does not approve when the user declines", async () => {
		const h = await reviewing();
		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });
		h.confirm.mockImplementationOnce(async () => false);

		const result = await h.runTool("plan_tickets", { action: "approve" });

		expect(result.details?.approved).toBe(false);
	});

	it("publishes approved tickets to Beads and advances to scheduling", async () => {
		const bd = fakeBd();
		const h = await reviewing({ exec: bd.exec });
		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });
		await h.runTool("plan_tickets", { action: "approve" });

		const result = await h.runTool("plan_tickets", { action: "publish" });

		expect(result.details?.phase).toBe("scheduling");
		expect(result.details?.tracker).toBe("beads");
		expect(bd.order).toHaveLength(4);
		expect(bd.edges).toHaveLength(2);
		expect(h.activeTools()).not.toContain("write"); // still in plan mode after publication
	});

	it("falls back to Markdown tickets in the project and tells the user", async () => {
		const cwd = tmp();
		const h = await reviewing({ cwd, exec: fakeBd({ usable: false }).exec });
		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });
		await h.runTool("plan_tickets", { action: "approve" });

		const result = await h.runTool("plan_tickets", { action: "publish" });

		expect(result.details?.tracker).toBe("markdown");
		expect(result.details?.phase).toBe("scheduling");
		expect(readdirSync(join(cwd, "tickets"))).toHaveLength(4);
		expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/markdown/i), expect.anything());
	});

	it("blocks publication after a requirements gap until drafts are reviewed again", async () => {
		const bd = fakeBd();
		const h = await reviewing({ exec: bd.exec });
		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });
		await h.runTool("plan_tickets", { action: "approve" });
		await h.runTool("plan_phase", { phase: "grilling", reason: "auth strategy is undecided" });
		await h.runTool("plan_confirm", { kind: "outcome", summary: "o2" });
		await h.runTool("plan_confirm", { kind: "system_model", summary: "s2" });
		await h.runTool("plan_phase", { phase: "ticketing" });

		await expect(h.runTool("plan_tickets", { action: "publish" })).rejects.toThrow(/review|approv|submit/i);
		expect(bd.order).toHaveLength(0);

		await h.runTool("plan_tickets", { action: "submit_drafts", epic, drafts: chain });
		await h.runTool("plan_tickets", { action: "approve" });
		expect((await h.runTool("plan_tickets", { action: "publish" })).details?.phase).toBe("scheduling");
	});
});
