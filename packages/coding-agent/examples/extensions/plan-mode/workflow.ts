/**
 * Plan workflow state: phases, user confirmations, and the transitions between phases.
 *
 * Every transition is a pure function from the current session to the next one. A move that is
 * not allowed throws an Error that explains why; the extension reports that error to the agent.
 * The extension applies the returned session and persists it.
 */

import type { DraftTicket, PublishResult, TicketEpic } from "./tickets.ts";

export const PLAN_PHASES = [
	"readiness",
	"grilling",
	"confirming",
	"ticketing",
	"reviewing",
	"scheduling",
	"ready",
] as const;

export type PlanPhase = (typeof PLAN_PHASES)[number];

export function isPlanPhase(value: unknown): value is PlanPhase {
	return typeof value === "string" && (PLAN_PHASES as readonly string[]).includes(value);
}

/** What the user must confirm before ticketing: the desired outcome, and the system/domain model. */
export const CONFIRMATION_KINDS = ["outcome", "system_model"] as const;

export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

export const CONFIRMATION_LABELS: Record<ConfirmationKind, string> = {
	outcome: "desired outcome and constraints",
	system_model: "system and domain model",
};

/** Confirmed summary per kind. A missing key means that kind is not confirmed. */
export type PlanConfirmations = Partial<Record<ConfirmationKind, string>>;

export type ReadinessChoice = "grill" | "ticket";

/** The drafted ticket set under review. */
export interface TicketDrafts {
	epic: TicketEpic;
	tickets: DraftTicket[];
}

/** Live state while plan mode is active. Absent when plan mode is off. */
export interface PlanSession {
	phase: PlanPhase;
	/** Active tool names to restore when plan mode ends. */
	toolsBeforePlanMode: string[];
	confirmations: PlanConfirmations;
	/** Set once ticket drafting has sent the workflow back to grilling. Cleared when revised drafts are submitted. */
	reReviewRequired: boolean;
	/** Why the workflow last returned to grilling. Not persisted. */
	returnReason?: string;
	/** Drafted tickets under review. Set by submit_drafts. */
	drafts?: TicketDrafts;
	/** The user approved `drafts`. Submitting new drafts clears it. */
	draftsApproved: boolean;
	/** Result of the last publication. Set when the workflow moves to scheduling. */
	published?: PublishResult;
	/** A schedule was proposed for the published tickets and not yet agreed or revoked. */
	scheduleProposed: boolean;
	/** The user agreed the proposed schedule. Only an agreement reaches ready. */
	scheduleAgreed: boolean;
}

/** Payload of the `plan-mode` custom session entry. */
export interface PlanModeEntry {
	enabled: boolean;
	phase?: PlanPhase;
	toolsBeforePlanMode?: string[];
	confirmations?: PlanConfirmations;
	reReviewRequired?: boolean;
	drafts?: TicketDrafts;
	draftsApproved?: boolean;
	published?: PublishResult;
	scheduleProposed?: boolean;
	scheduleAgreed?: boolean;
}

/** Rejects a readiness call outside the readiness phase, before the user is asked anything. */
export function assertReadinessOpen(session: PlanSession): void {
	if (session.phase !== "readiness") {
		throw new Error(`plan_readiness only runs in the readiness phase. The workflow is in ${session.phase}.`);
	}
}

/** Records the readiness choice: grill moves to grilling, ticket moves to confirming. */
export function chooseReadiness(session: PlanSession, choice: ReadinessChoice): PlanSession {
	return { ...session, phase: choice === "grill" ? "grilling" : "confirming" };
}

/**
 * Records the user's answer to a confirmation request. A declined summary means the shared
 * understanding is wrong, so the workflow returns to grilling and the confirmations reset.
 */
export function answerConfirmation(
	session: PlanSession,
	kind: ConfirmationKind,
	summary: string,
	confirmed: boolean,
): PlanSession {
	if (!confirmed) {
		return returnToGrilling(session, `the user did not confirm the ${CONFIRMATION_LABELS[kind]}: ${summary}`);
	}
	return { ...session, confirmations: { ...session.confirmations, [kind]: summary } };
}

/**
 * Moves to `target`. Ticketing needs both confirmations. Going back to grilling from a later phase
 * needs a reason, and it resets the confirmations.
 */
export function movePhase(session: PlanSession, target: PlanPhase, reason?: string): PlanSession {
	if (target === "ticketing") {
		const missing = CONFIRMATION_KINDS.filter((kind) => session.confirmations[kind] === undefined);
		if (missing.length > 0) {
			throw new Error(
				`Cannot start ticketing: the user has not confirmed ${missing.join(", ")}. Confirm each with plan_confirm first.`,
			);
		}
	}
	if (target === "reviewing" || target === "scheduling") {
		throw new Error(
			`Cannot move to ${target} with plan_phase. Drafts reach reviewing through plan_tickets submit_drafts, and scheduling through plan_tickets publish.`,
		);
	}
	if (target === "ready") {
		throw new Error(
			"Cannot move to ready with plan_phase. Reaching ready needs the user's agreement: propose the schedule with plan_schedule propose, then call plan_schedule agree, the only way to ready.",
		);
	}
	const returningToGrilling =
		target === "grilling" && PLAN_PHASES.indexOf(session.phase) > PLAN_PHASES.indexOf("grilling");
	if (returningToGrilling) return returnToGrilling(session, reason ?? "");
	return {
		...session,
		phase: target,
		returnReason: undefined,
		scheduleProposed: false,
		scheduleAgreed: false,
	};
}

function returnToGrilling(session: PlanSession, reason: string): PlanSession {
	if (!reason.trim()) {
		throw new Error("Returning to grilling needs a reason. Name the requirement that is still undecided.");
	}
	const ticketsMayExist = PLAN_PHASES.indexOf(session.phase) >= PLAN_PHASES.indexOf("ticketing");
	return {
		...session,
		phase: "grilling",
		confirmations: {},
		draftsApproved: false,
		scheduleProposed: false,
		scheduleAgreed: false,
		reReviewRequired: session.reReviewRequired || ticketsMayExist,
		returnReason: reason.trim(),
	};
}

/**
 * Stores a drafted ticket set and moves to reviewing. Earlier approval and the re-review flag are
 * void: the user must review this set. Drafts are accepted in ticketing and reviewing, so the agent
 * can revise them.
 */
export function submitDrafts(session: PlanSession, drafts: TicketDrafts): PlanSession {
	if (session.phase !== "ticketing" && session.phase !== "reviewing") {
		throw new Error(`Drafts are submitted in the ticketing phase. The workflow is in ${session.phase}.`);
	}
	return {
		...session,
		phase: "reviewing",
		drafts,
		draftsApproved: false,
		reReviewRequired: false,
		scheduleProposed: false,
		scheduleAgreed: false,
	};
}

/** Rejects an approval request before the user is asked: approval needs submitted drafts. */
export function assertDraftsReviewable(session: PlanSession): TicketDrafts {
	if (session.phase !== "reviewing" || !session.drafts) {
		throw new Error(`Tickets are approved in reviewing, after submit_drafts. The workflow is in ${session.phase}.`);
	}
	return session.drafts;
}

/** Returns the drafts to publish. Publication needs a current review: not re-review-pending and approved. */
export function assertPublishable(session: PlanSession): TicketDrafts {
	if (session.reReviewRequired) {
		throw new Error(
			"The drafts were written before the return to grilling. Revise them with plan_tickets submit_drafts, then get approval.",
		);
	}
	if (session.phase !== "reviewing" || !session.drafts) {
		throw new Error(`Publishing runs in reviewing, after submit_drafts. The workflow is in ${session.phase}.`);
	}
	if (!session.draftsApproved) {
		throw new Error(
			"The tickets are not approved. Ask the user to review them, then call plan_tickets with action approve.",
		);
	}
	return session.drafts;
}

/** Returns the published tickets a schedule is proposed for. Needs publication. */
export function assertPublished(session: PlanSession): PublishResult {
	if (!session.published) {
		throw new Error(
			"The schedule is proposed from published tickets. Publish them with plan_tickets action publish first.",
		);
	}
	return session.published;
}

/** Rejects agreement before a proposal: the user agrees only a schedule the agent proposed in scheduling. */
export function assertScheduleProposed(session: PlanSession): void {
	if (session.phase !== "scheduling" || !session.scheduleProposed) {
		throw new Error("The schedule is agreed after propose: call plan_schedule propose first, then agree.");
	}
}

/** Records a proposed schedule and moves to scheduling. A new proposal revokes any earlier agreement. */
export function proposeSchedule(session: PlanSession): PlanSession {
	if (session.phase !== "scheduling" && session.phase !== "ready") {
		throw new Error(`The schedule is proposed after publish, in scheduling. The workflow is in ${session.phase}.`);
	}
	return { ...session, phase: "scheduling", scheduleProposed: true, scheduleAgreed: false };
}

/** Marks the proposed schedule as agreed by the user and moves to ready. */
export function agreeSchedule(session: PlanSession): PlanSession {
	assertScheduleProposed(session);
	return { ...session, phase: "ready", scheduleProposed: false, scheduleAgreed: true };
}
