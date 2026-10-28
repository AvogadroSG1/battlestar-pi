/**
 * Orchestration state for the tickets handed off by plan mode: which ticket may be dispatched, how
 * many help requests and review/fix cycles it has used, and when it must go to joint framing or
 * arbitration. The state machine is pure; `closeInTracker` is the only part that touches the
 * tracker (Beads or the Markdown files written by tickets.ts).
 *
 * Ticket path: pending -> contracted (red BDD contract) -> implementing -> verifying -> verified
 * -> closed. A failing review goes to fixing (at most two ordinary cycles), then framing, then
 * arbitrating or awaiting_user. Any ticket blocked by an awaiting_user ticket is paused too.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./tickets.ts";

export const JOINT_FRAMING_FILE = "docs/planning_support_docs/joint-framing.md";

export const HELP_LIMIT = 2;
export const ORDINARY_CYCLES = 2;

export type OrchestrationStatus =
	| "pending"
	| "contracted"
	| "implementing"
	| "verifying"
	| "fixing"
	| "framing"
	| "arbitrating"
	| "awaiting_user"
	| "verified"
	| "closed";

export interface TicketSpec {
	id: string;
	blockedBy: string[];
}

export interface RedContract {
	testPath: string;
	acceptance: string;
}

export type ReviewDecision =
	| { action: "close" }
	| { action: "fix"; cycle: number }
	| { action: "joint_framing"; file: string }
	| { action: "pause_for_user" }
	| { action: "arbitrate"; reasoning: "medium"; askUser: boolean };

export interface Finding {
	severity: "low" | "medium" | "high";
	message: string;
}

export type FramingConcern = "none" | "destructive-data" | "security";

export type OrchestrationTracker = { kind: "beads"; root: string } | { kind: "markdown"; dir: string };

export type Decision =
	| ReviewDecision
	| { action: "fix"; extra: true }
	| { action: "fix"; decision: string }
	| { action: "resume"; userDecision: string };

export interface TicketState {
	id: string;
	blockedBy: string[];
	status: OrchestrationStatus;
	contract?: RedContract;
	helpGrants: number;
	reviewCycles: number;
	extraCyclePending: boolean;
	arbitrated: boolean;
	decision?: string;
	concern?: FramingConcern;
}

export interface OrchestratorSnapshot {
	tickets: TicketState[];
}

export class Orchestrator {
	private readonly tickets = new Map<string, TicketState>();

	constructor(specs: TicketSpec[]) {
		for (const spec of specs) {
			if (this.tickets.has(spec.id)) throw new Error(`Ticket ${spec.id} is listed twice`);
			this.tickets.set(spec.id, {
				id: spec.id,
				blockedBy: [...spec.blockedBy],
				status: "pending",
				helpGrants: 0,
				reviewCycles: 0,
				extraCyclePending: false,
				arbitrated: false,
			});
		}
	}

	static fromJSON(snapshot: OrchestratorSnapshot): Orchestrator {
		const orchestrator = new Orchestrator(snapshot.tickets.map((t) => ({ id: t.id, blockedBy: t.blockedBy })));
		for (const t of snapshot.tickets) orchestrator.tickets.set(t.id, { ...t, blockedBy: [...t.blockedBy] });
		return orchestrator;
	}

	toJSON(): OrchestratorSnapshot {
		return { tickets: [...this.tickets.values()].map((t) => ({ ...t, blockedBy: [...t.blockedBy] })) };
	}

	status(id: string): OrchestrationStatus {
		return this.ticket(id).status;
	}

	statuses(): Record<string, OrchestrationStatus> {
		return Object.fromEntries([...this.tickets.values()].map((t) => [t.id, t.status]));
	}

	/** Pending tickets whose blockers are all closed and that are not paused. */
	ready(): string[] {
		const paused = new Set(this.pausedWork());
		return [...this.tickets.values()]
			.filter((t) => t.status === "pending" && this.openBlockers(t).length === 0 && !paused.has(t.id))
			.map((t) => t.id);
	}

	/** Contracted tickets whose blockers are all closed and that are not paused. */
	dispatchable(): string[] {
		const paused = new Set(this.pausedWork());
		return [...this.tickets.values()]
			.filter((t) => t.status === "contracted" && this.openBlockers(t).length === 0 && !paused.has(t.id))
			.map((t) => t.id);
	}

	/** Awaiting-user tickets plus every open ticket that is transitively blocked by one of them. */
	pausedWork(): string[] {
		const paused = new Set<string>();
		for (const t of this.tickets.values()) if (t.status === "awaiting_user") paused.add(t.id);
		let grew = true;
		while (grew) {
			grew = false;
			for (const t of this.tickets.values()) {
				if (paused.has(t.id) || t.status === "closed") continue;
				if (t.blockedBy.some((blocker) => paused.has(blocker))) {
					paused.add(t.id);
					grew = true;
				}
			}
		}
		return [...paused];
	}

	recordRedContract(id: string, contract: RedContract): void {
		const t = this.ticket(id);
		this.assertUnblocked(t);
		this.requireStatus(t, ["pending"], "take a red contract");
		if (!contract.testPath.trim() || !contract.acceptance.trim()) {
			throw new Error(`Ticket ${id}: the red contract needs a testPath and an acceptance scenario`);
		}
		t.contract = { ...contract };
		t.status = "contracted";
	}

	dispatch(id: string): void {
		const t = this.ticket(id);
		this.assertUnblocked(t);
		if (this.pausedWork().includes(id)) {
			throw new Error(`Ticket ${id} is paused: it waits for the user's decision before any work`);
		}
		if (t.status === "pending") {
			throw new Error(`Ticket ${id} needs a failing BDD contract before dispatch: call red_contract first`);
		}
		this.requireStatus(t, ["contracted"], "be dispatched");
		t.status = "implementing";
	}

	/** Grants at most two orchestrator-help requests per ticket. */
	requestHelp(id: string): { granted: boolean; remaining: number } {
		const t = this.ticket(id);
		this.requireStatus(t, ["implementing", "fixing"], "ask for help");
		if (t.helpGrants >= HELP_LIMIT) return { granted: false, remaining: 0 };
		t.helpGrants += 1;
		return { granted: true, remaining: HELP_LIMIT - t.helpGrants };
	}

	submitWork(id: string): void {
		const t = this.ticket(id);
		this.requireStatus(t, ["implementing", "fixing"], "submit work");
		t.status = "verifying";
	}

	/**
	 * Verifies the work against its findings. Only low-severity findings verify the ticket. Otherwise
	 * the ticket gets two ordinary fix cycles, then joint framing. The one extra cycle granted by an
	 * agreed framing goes to arbitration when it fails. Once arbitration has happened, any further
	 * failure pauses the ticket for the user.
	 */
	recordReview(id: string, findings: Finding[]): ReviewDecision {
		const t = this.ticket(id);
		this.requireStatus(t, ["implementing", "verifying"], "be reviewed");
		if (!findings.some((finding) => finding.severity !== "low")) {
			t.status = "verified";
			return { action: "close" };
		}
		if (t.arbitrated) {
			t.status = "awaiting_user";
			return { action: "pause_for_user" };
		}
		if (t.extraCyclePending) {
			t.extraCyclePending = false;
			const askUser = t.concern === "destructive-data" || t.concern === "security";
			t.status = askUser ? "awaiting_user" : "arbitrating";
			return { action: "arbitrate", reasoning: "medium", askUser };
		}
		if (t.reviewCycles < ORDINARY_CYCLES) {
			t.reviewCycles += 1;
			t.status = "fixing";
			return { action: "fix", cycle: t.reviewCycles };
		}
		t.status = "framing";
		return { action: "joint_framing", file: JOINT_FRAMING_FILE };
	}

	/**
	 * Records the framing outcome and its concern. An agreed pathway grants one extra work/review
	 * cycle. Without agreement, a destructive-data or security concern pauses the ticket for the
	 * user; any other concern goes to arbitration. The concern is kept on the ticket, so a failed
	 * extra cycle under a sensitive concern also pauses for the user.
	 */
	recordFramingOutcome(
		id: string,
		outcome: { agreed: boolean; pathway?: string; concern?: FramingConcern },
	): Decision {
		const t = this.ticket(id);
		this.requireStatus(t, ["framing"], "record a framing outcome");
		if (outcome.agreed) {
			if (!outcome.pathway?.trim()) throw new Error(`Ticket ${id}: an agreed framing needs the agreed pathway`);
			t.concern = outcome.concern;
			t.extraCyclePending = true;
			t.status = "fixing";
			return { action: "fix", extra: true };
		}
		t.concern = outcome.concern;
		const askUser = outcome.concern === "destructive-data" || outcome.concern === "security";
		t.status = askUser ? "awaiting_user" : "arbitrating";
		return { action: "arbitrate", reasoning: "medium", askUser };
	}

	/**
	 * Applies the arbitrator's decision (status arbitrating), or resumes a paused ticket with the
	 * user's decision (status awaiting_user). A paused ticket cannot resume on the arbitrator's word.
	 */
	recordArbitration(id: string, record: { decision: string; userDecision?: string }): Decision {
		const t = this.ticket(id);
		if (t.status === "awaiting_user") {
			const userDecision = record.userDecision?.trim();
			if (!userDecision) {
				throw new Error(`Ticket ${id} is waiting for the user: record the user's answer as userDecision to resume`);
			}
			t.status = "implementing";
			t.arbitrated = true;
			t.decision = userDecision;
			return { action: "resume", userDecision };
		}
		this.requireStatus(t, ["arbitrating"], "record an arbitration");
		if (!record.decision.trim()) throw new Error(`Ticket ${id}: the arbitrator's decision is empty`);
		t.status = "implementing";
		t.arbitrated = true;
		t.decision = record.decision;
		return { action: "fix", decision: record.decision };
	}

	requireVerified(id: string): void {
		const t = this.ticket(id);
		if (t.status !== "verified") {
			throw new Error(`Ticket ${id} is not verified (status: ${t.status}); only verified work can be closed`);
		}
	}

	close(id: string): void {
		this.requireVerified(id);
		this.ticket(id).status = "closed";
	}

	private ticket(id: string): TicketState {
		const t = this.tickets.get(id);
		if (!t) throw new Error(`Unknown ticket ${id}. Known tickets: ${[...this.tickets.keys()].join(", ")}`);
		return t;
	}

	/** Blockers outside the ticket list count as already closed. */
	private openBlockers(t: TicketState): string[] {
		return t.blockedBy.filter((blocker) => {
			const state = this.tickets.get(blocker);
			return state !== undefined && state.status !== "closed";
		});
	}

	private assertUnblocked(t: TicketState): void {
		const open = this.openBlockers(t);
		if (open.length > 0) throw new Error(`Ticket ${t.id} is blocked by open tickets: ${open.join(", ")}`);
	}

	private requireStatus(t: TicketState, allowed: OrchestrationStatus[], action: string): void {
		if (!allowed.includes(t.status)) throw new Error(`Ticket ${t.id} cannot ${action} from status ${t.status}`);
	}
}

/**
 * Closes one ticket in the tracker: `bd close <id>` for Beads, or `Status: open` to
 * `Status: closed` in `<dir>/<id>.md` for Markdown. Failures throw, so the caller keeps the
 * ticket unclosed in orchestration state.
 */
export async function closeInTracker(exec: CommandRunner, tracker: OrchestrationTracker, id: string): Promise<void> {
	if (tracker.kind === "beads") {
		const output = await exec("bd", ["close", id]);
		if (output.code !== 0) {
			throw new Error(
				`bd close ${id} failed: ${(output.stderr || output.stdout).trim() || `exit code ${output.code}`}`,
			);
		}
		return;
	}
	if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Ticket id "${id}" is not a Markdown file name`);
	const file = join(tracker.dir, `${id}.md`);
	const text = readFileSync(file, "utf8");
	if (/^Status: closed$/m.test(text)) return;
	if (!/^Status: open$/m.test(text)) throw new Error(`${file} has no "Status: open" line to close`);
	writeFileSync(file, text.replace(/^Status: open$/m, "Status: closed"));
}
