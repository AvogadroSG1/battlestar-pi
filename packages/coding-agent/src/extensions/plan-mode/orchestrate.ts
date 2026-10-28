/**
 * The `orchestrate` tool: runs the tickets handed off by plan mode. Each action changes the
 * Orchestrator (orchestration.ts), closes tickets in the tracker, and returns text that tells the
 * agent the next step. The state is persisted by index.ts as a `plan-orchestration` entry.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import {
	closeInTracker,
	type Decision,
	type Finding,
	type FramingConcern,
	HELP_LIMIT,
	JOINT_FRAMING_FILE,
	ORDINARY_CYCLES,
	type OrchestrationTracker,
	Orchestrator,
	type OrchestratorSnapshot,
	type ReviewDecision,
} from "./orchestration.ts";
import { readPlanModeSkills } from "./skills.ts";
import type { CommandRunner } from "./tickets.ts";

export const ORCHESTRATION_ENTRY = "plan-orchestration";
export const ORCHESTRATION_CONTEXT = "plan-orchestration-context";

const ORCHESTRATE_ACTIONS = [
	"init",
	"red_contract",
	"dispatch",
	"help",
	"submit_work",
	"review",
	"framing",
	"arbitration",
	"close",
	"status",
] as const;

const SEVERITIES = ["low", "medium", "high"] as const;
const CONCERNS = ["none", "destructive-data", "security"] as const;

export const orchestrateParams = Type.Object({
	action: StringEnum(ORCHESTRATE_ACTIONS),
	ticketId: Type.Optional(
		Type.String({ description: "The ticket id. Required for every action except init and status" }),
	),
	tickets: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				blockedBy: Type.Array(Type.String({ description: "Ids of tickets that must close first" })),
			}),
			{ description: "init: the open tickets of the approved schedule, with their blocker ids" },
		),
	),
	tracker: Type.Optional(
		Type.Object({
			kind: StringEnum(["beads", "markdown"]),
			dir: Type.Optional(Type.String({ description: "markdown: directory holding the ticket files" })),
		}),
	),
	testPath: Type.Optional(Type.String({ description: "red_contract: the failing BDD test file" })),
	acceptance: Type.Optional(
		Type.String({ description: "red_contract: the Given/When/Then scenario the test encodes" }),
	),
	findings: Type.Optional(
		Type.Array(
			Type.Object({
				severity: StringEnum(SEVERITIES),
				message: Type.String(),
			}),
			{ description: "review: findings from verifying the work. Empty when the work is clean" },
		),
	),
	agreed: Type.Optional(Type.Boolean({ description: "framing: whether the joint framing agreed a pathway" })),
	pathway: Type.Optional(Type.String({ description: "framing: the agreed pathway" })),
	concern: Type.Optional(StringEnum(CONCERNS, { description: "framing: the concern when no pathway is agreed" })),
	decision: Type.Optional(Type.String({ description: "arbitration: the arbitrator's decision" })),
	userDecision: Type.Optional(Type.String({ description: "arbitration: the user's answer for a paused ticket" })),
});

export type OrchestrateParams = Static<typeof orchestrateParams>;

/** Live orchestration: the tracker that holds the tickets, and the state machine over them. */
export interface Orchestration {
	tracker: OrchestrationTracker;
	orchestrator: Orchestrator;
}

export interface OrchestrationEntry {
	tracker: OrchestrationTracker;
	tickets: OrchestratorSnapshot;
}

export interface OrchestrateResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown> & { status: string; ready: string[] };
}

export interface OrchestrateOutcome {
	orchestration: Orchestration;
	result: OrchestrateResult;
}

const NOT_INITIALIZED =
	"Orchestration is not initialized. Call orchestrate with action init, the tickets, and the tracker from the plan handoff first.";

export function orchestrationEntry(orchestration: Orchestration): OrchestrationEntry {
	return { tracker: orchestration.tracker, tickets: orchestration.orchestrator.toJSON() };
}

export function restoreOrchestration(entry: OrchestrationEntry): Orchestration {
	return { tracker: entry.tracker, orchestrator: Orchestrator.fromJSON(entry.tickets) };
}

/** Runs one action. Throws with the reason when the action is not allowed, leaving the state as it was. */
export async function runOrchestrate(
	current: Orchestration | undefined,
	params: OrchestrateParams,
	exec: CommandRunner,
): Promise<OrchestrateOutcome> {
	if (params.action === "init") {
		if (current) throw new Error("Orchestration is already initialized. Use action status to see it.");
		const orchestration = initialize(params);
		return {
			orchestration,
			result: report(
				orchestration,
				"orchestrating",
				`Orchestration initialized with ${params.tickets?.length ?? 0} tickets.\n${readyText(orchestration)}`,
			),
		};
	}
	if (!current) throw new Error(NOT_INITIALIZED);
	const orchestration = current;
	const o = current.orchestrator;

	switch (params.action) {
		case "status":
			return { orchestration, result: statusReport(orchestration) };

		case "red_contract": {
			const id = requireTicketId(params);
			if (!params.testPath || !params.acceptance) {
				throw new Error(
					"red_contract needs testPath and acceptance: the failing BDD test the implementor must make pass.",
				);
			}
			o.recordRedContract(id, { testPath: params.testPath, acceptance: params.acceptance });
			return {
				orchestration,
				result: report(
					orchestration,
					o.status(id),
					`Red contract recorded for ${id}: ${params.testPath} must fail now and pass when the ticket is done.\nAcceptance: ${params.acceptance}\nUse the bundled TDD guidance to write the failing test first, confirm it fails, then dispatch ${id}.`,
				),
			};
		}

		case "dispatch": {
			const id = requireTicketId(params);
			o.dispatch(id);
			const contract = o.toJSON().tickets.find((t) => t.id === id)?.contract;
			return {
				orchestration,
				result: report(
					orchestration,
					o.status(id),
					`Dispatched ${id} to an implementor.\nGive it the ticket in the tracker, its red contract (${contract?.testPath}: ${contract?.acceptance}), and these rules: make the test pass without editing it; self-check with the bundled code-review guidance; call orchestrate submit_work when done; ask for help only when blocked.\n${readyText(orchestration)}`,
				),
			};
		}

		case "help": {
			const id = requireTicketId(params);
			const { granted, remaining } = o.requestHelp(id);
			const text = granted
				? `Orchestrator help granted for ${id} (${remaining} request${remaining === 1 ? "" : "s"} left). Answer the implementor's question, then let it continue.`
				: `Help budget used up for ${id} (${HELP_LIMIT} of ${HELP_LIMIT} requests). Do not ask again: the implementor finishes the attempt, submits the work, and review decides. Diagnose the blocker with the bundled diagnosing-bugs guidance.`;
			return { orchestration, result: report(orchestration, o.status(id), text, { granted, remaining }) };
		}

		case "submit_work": {
			const id = requireTicketId(params);
			o.submitWork(id);
			return {
				orchestration,
				result: report(
					orchestration,
					o.status(id),
					`Work submitted for ${id}. Verify it with the bundled code-review guidance against the red contract and its acceptance scenario, then call orchestrate review with the findings (an empty list when it is clean).`,
				),
			};
		}

		case "review": {
			const id = requireTicketId(params);
			const findings: Finding[] = params.findings ?? [];
			const decision = o.recordReview(id, findings);
			return {
				orchestration,
				result: report(orchestration, o.status(id), reviewText(orchestration, id, decision, findings)),
			};
		}

		case "framing": {
			const id = requireTicketId(params);
			if (params.agreed === undefined)
				throw new Error("framing needs agreed: true with a pathway, or false with a concern.");
			const decision = o.recordFramingOutcome(id, {
				agreed: params.agreed,
				pathway: params.pathway,
				concern: params.concern as FramingConcern | undefined,
			});
			return {
				orchestration,
				result: report(orchestration, o.status(id), framingText(orchestration, id, decision, params)),
			};
		}

		case "arbitration": {
			const id = requireTicketId(params);
			if (!params.decision && !params.userDecision) {
				throw new Error("arbitration needs decision (the arbitrator's) or userDecision (the user's answer).");
			}
			const decision = o.recordArbitration(id, {
				decision: params.decision ?? "",
				userDecision: params.userDecision,
			});
			const text =
				decision.action === "resume"
					? `${id} resumed with the user's decision: ${decision.userDecision}. Paused work is released. The implementor continues: submit_work, then review. Keep the final report in docs/escalation/ (see ${JOINT_FRAMING_FILE}).`
					: `Arbitration decision for ${id}: ${params.decision}. The implementor applies it, then submit_work and review. A failed review now pauses the ticket for the user. Keep the final report in docs/escalation/ (see ${JOINT_FRAMING_FILE}).`;
			return { orchestration, result: report(orchestration, o.status(id), text) };
		}

		case "close": {
			const id = requireTicketId(params);
			o.requireVerified(id);
			await closeInTracker(exec, orchestration.tracker, id);
			o.close(id);
			return {
				orchestration,
				result: report(
					orchestration,
					o.status(id),
					`Closed ${id} in the ${orchestration.tracker.kind} tracker.\n${readyText(orchestration)}`,
				),
			};
		}
	}
}

function initialize(params: OrchestrateParams): Orchestration {
	if (!params.tickets || params.tickets.length === 0) {
		throw new Error("init needs tickets: [{ id, blockedBy }] for the open tickets of the approved schedule.");
	}
	const tracker = params.tracker;
	if (!tracker) throw new Error('init needs tracker: { kind: "beads" } or { kind: "markdown", dir }.');
	if (tracker.kind === "markdown") {
		if (!tracker.dir) throw new Error('init with a markdown tracker needs its directory: { kind: "markdown", dir }.');
		return { tracker: { kind: "markdown", dir: tracker.dir }, orchestrator: new Orchestrator(params.tickets) };
	}
	return { tracker: { kind: "beads" }, orchestrator: new Orchestrator(params.tickets) };
}

function requireTicketId(params: OrchestrateParams): string {
	if (!params.ticketId) throw new Error(`${params.action} needs ticketId.`);
	return params.ticketId;
}

function readyText(orchestration: Orchestration): string {
	const o = orchestration.orchestrator;
	const ready = o.ready();
	const dispatchable = o.dispatchable();
	const paused = o.pausedWork();
	return [
		`Ready for red_contract: ${ready.join(", ") || "none"}.`,
		`Ready to dispatch: ${dispatchable.join(", ") || "none"}. Dispatch independent tickets in parallel.`,
		paused.length > 0 ? `Paused, waiting for the user: ${paused.join(", ")}.` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function statusReport(orchestration: Orchestration): OrchestrateResult {
	const statuses = orchestration.orchestrator.statuses();
	const lines = Object.entries(statuses).map(([id, status]) => `- ${id}: ${status}`);
	return report(orchestration, "orchestrating", `Tickets:\n${lines.join("\n")}\n${readyText(orchestration)}`, {
		statuses,
	});
}

function report(
	orchestration: Orchestration,
	status: string,
	text: string,
	extra: Record<string, unknown> = {},
): OrchestrateResult {
	const o = orchestration.orchestrator;
	return {
		content: [{ type: "text", text }],
		details: {
			status,
			ready: o.ready(),
			dispatchable: o.dispatchable(),
			paused: o.pausedWork(),
			...extra,
		},
	};
}

function findingsText(findings: Finding[]): string {
	if (findings.length === 0) return "(no findings)";
	return findings.map((finding) => `- [${finding.severity}] ${finding.message}`).join("\n");
}

function reviewText(orchestration: Orchestration, id: string, decision: ReviewDecision, findings: Finding[]): string {
	switch (decision.action) {
		case "close":
			return `${id} verified: no medium or high findings. Close it with orchestrate close before dispatching the tickets it unblocks.\n${readyText(orchestration)}`;
		case "fix":
			return `${id}: fix cycle ${decision.cycle} of ${ORDINARY_CYCLES}. Send the implementor these findings:\n${findingsText(findings)}\nThe implementor fixes them, then orchestrate submit_work, then review again.`;
		case "joint_framing":
			return `${id}: ${ORDINARY_CYCLES} fix cycles did not clear the review. Joint framing is next. The implementor and the orchestrator fill in and review ${decision.file} together: each writes the other side's option, and each marks Resolved or Escalate. Then call orchestrate framing with agreed true and the pathway, or agreed false with a concern (none, destructive-data, security). Do not dispatch more work on ${id} until that outcome is recorded.`;
		case "pause_for_user":
			return `${id}: arbitrated work still fails review, so it is paused. Ask the user what to do, then record the answer with orchestrate arbitration and userDecision. Paused: ${orchestration.orchestrator.pausedWork().join(", ")}. Keep the final report in docs/escalation/ (see ${JOINT_FRAMING_FILE}).`;
		case "arbitrate":
			return arbitrationText(orchestration, id, decision.askUser, "the agreed pathway failed review");
	}
}

const ARBITRATOR = `Spawn a fresh subagent as the arbitrator at MEDIUM reasoning. It decides ONLY from the completed joint brief in ${JOINT_FRAMING_FILE} and must not read more code. Its final report goes in docs/escalation/, owned by the arbitrator since it decided. Record its decision with orchestrate arbitration and decision.`;

/** Arbitration instructions. For a destructive-data or security concern the work pauses and the arbitrator asks the user. */
function arbitrationText(orchestration: Orchestration, id: string, askUser: boolean, lead: string): string {
	if (!askUser) return `${id}: ${lead}. ${ARBITRATOR}`;
	return `${id}: ${lead}. Work is paused (${orchestration.orchestrator.pausedWork().join(", ")}). ${ARBITRATOR} For this concern the arbitrator asks the user what to do and carries that decision through: record the user's answer with orchestrate arbitration and userDecision.`;
}

function framingText(orchestration: Orchestration, id: string, decision: Decision, params: OrchestrateParams): string {
	if (decision.action === "fix") {
		return `Pathway agreed for ${id}: ${params.pathway}. One extra work/review cycle is granted: the implementor applies this pathway, then submit_work and review. If that cycle fails, the ticket goes to arbitration or, for a destructive-data or security concern, pauses for the user. Framing file: ${JOINT_FRAMING_FILE}.`;
	}
	if (decision.action !== "arbitrate") throw new Error(`Unexpected framing decision for ${id}: ${decision.action}`);
	const lead = decision.askUser ? `no pathway agreed and the concern is ${params.concern}` : "no pathway agreed";
	return arbitrationText(orchestration, id, decision.askUser, lead);
}

/** Rules for the orchestrating agent. Injected before each prompt once orchestration is active. */
export function orchestrationContext(): string {
	const guidance = `[ORCHESTRATION]
You orchestrate the tickets of the approved plan. The user already approved the schedule: do not ask for approval again.
- Before dispatch, write the failing BDD test for each ticket using the bundled TDD guidance and record it with orchestrate red_contract.
- Dispatch only tickets whose blockers are closed. Dispatch independent ready tickets in parallel.
- An implementor may ask for orchestrator help at most 2 times per ticket.
- Verify completed work with the bundled code-review guidance, then call orchestrate review with the findings. Medium or high findings go back for a fix: at most 2 ordinary fix cycles.
- Stuck or failing work: use the bundled diagnosing-bugs guidance before escalating.
- After 2 fix cycles, joint framing: the implementor and you fill in and review ${JOINT_FRAMING_FILE}. An agreed pathway grants one more work/review cycle.
- If no pathway is agreed, a fresh medium-reasoning arbitrator decides only from the joint brief. For destructive-data or security concerns, the arbitrator asks the user, and work stays paused until the answer is recorded.
- Final reports for escalations go in docs/escalation/.
- Close a verified ticket in the tracker (orchestrate close) before dispatching the tickets it unblocks.
- Paused work stays paused until the decision is returned.`;
	return `${guidance}\n\nBundled skill guidance (private to Plan Mode):\n\n${readPlanModeSkills([
		"tdd",
		"code-review",
		"diagnosing-bugs",
		"codebase-design",
	])}`;
}
