/**
 * Plan-mode context injected before each user prompt. The base text holds the restrictions; the
 * phase guidance tells the agent what the current step needs. The grill-with-docs skill is named
 * only while grilling.
 */

import { CONFIRMATION_KINDS, CONFIRMATION_LABELS, type PlanSession } from "./workflow.ts";

export function planContext(session: PlanSession): string {
	const base = `[PLAN MODE ACTIVE]
You are in plan mode, a collaborative planning mode. Current phase: ${session.phase}.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.
Call plan_phase to move the workflow to the next phase.`;

	const guidance = phaseGuidance(session);
	return guidance ? `${base}\n\n${guidance}` : base;
}

function phaseGuidance(session: PlanSession): string {
	switch (session.phase) {
		case "readiness":
			return READINESS_GUIDANCE;
		case "grilling":
			return grillingGuidance(session.returnReason);
		case "confirming":
			return confirmingGuidance(session);
		case "ticketing":
			return ticketingGuidance(session);
		case "reviewing":
			return reviewingGuidance(session);
		case "scheduling":
			return SCHEDULING_GUIDANCE;
		case "ready":
			return READY_GUIDANCE;
		default:
			return "";
	}
}

const READINESS_GUIDANCE = `Readiness: decide whether this request can go straight to ticketing or needs requirements discovery first. Use the grilling skill (/skill:grilling) to judge readiness, and the domain-modeling skill (/skill:domain-modeling) for domain terms.
Explain your recommendation to the user, then call plan_readiness with recommendation "grill" (requirements are unclear or undecided) or "ticket" (the request is already specific), and a one-line rationale. The tool asks the user to agree or choose the other path.`;

function grillingGuidance(returnReason: string | undefined): string {
	const returned = returnReason
		? `The workflow returned to grilling because ${returnReason}. Resolve that first.\n`
		: "";
	return `Grilling: work out the requirements with /skill:grill-with-docs, which uses the grilling and domain-modeling skills. Do not write a numbered plan.
${returned}When the desired outcome and constraints are settled, and the system and domain model is clear, call plan_confirm with kind "outcome" and kind "system_model", each with a short summary. Then call plan_phase with phase "ticketing".`;
}

function confirmingGuidance(session: PlanSession): string {
	return `Confirming: check the shared understanding with the user before ticketing. Use the grilling and domain-modeling skills (/skill:grilling, /skill:domain-modeling) to restate it.
Call plan_confirm with kind "outcome" (the desired outcome and constraints) and kind "system_model" (the relevant system and domain model), each with a short summary. A declined summary sends the workflow back to grilling.
${confirmationStatus(session)}
When both are confirmed, call plan_phase with phase "ticketing".`;
}

function ticketingGuidance(session: PlanSession): string {
	const review = session.reReviewRequired
		? "Tickets drafted before the last return to grilling must be submitted again before publication.\n"
		: "";
	return `Ticketing: draft the tickets with /skill:to-tickets as vertical tracer-bullet slices, each with explicit blockers.
Submit the drafts with plan_tickets, action "submit_drafts", an epic {title, outcome}, and drafts. Each draft has:
- key: short unique key that blockedBy uses
- title and whatToBuild: the end-to-end behavior the slice makes work, from the user's perspective
- acceptance: BDD scenarios in Given/When/Then form, one per behavior. Each is a user-observable contract the implementor turns into a test.
- blockedBy: keys of the drafts that must finish first
- skills: the repository skills the implementor needs, each with one line of guidance on using it for this ticket (for example tdd: write the behavior test first)
If drafting exposes a requirement that is still undecided, call plan_phase with phase "grilling" and a reason that names it. That clears the confirmations, so both must be confirmed again before ticketing resumes.
${review}${confirmationStatus(session)}`;
}

function reviewingGuidance(session: PlanSession): string {
	const tickets = session.drafts?.tickets ?? [];
	const list = tickets.map(
		(ticket) =>
			`- ${ticket.key}: ${ticket.title}${ticket.blockedBy.length > 0 ? ` (blocked by ${ticket.blockedBy.join(", ")})` : ""}`,
	);
	return `Reviewing: the drafted tickets are below. Ask the user two questions: is the granularity right (too coarse or too fine), and is each blocker a real dependency? Revise with plan_tickets, action "submit_drafts", and ask again until the user agrees.
When they agree, call plan_tickets with action "approve". The user confirms there. Publishing is refused until the tickets are approved.
Drafted tickets:
${list.join("\n")}`;
}

const SCHEDULING_GUIDANCE = `Scheduling: the tickets are published. Call plan_schedule with action "propose". It reads each ticket's status and blocker edges from the tracker, and returns the order in waves.
Present the order to the user: which tickets run first, and which run in parallel. Tickets run in parallel only when they are independent, with no blocker edge between them. Never mark a blocked ticket as parallel with its blocker.
Then ask the user to agree the order and call plan_schedule with action "agree". The tool asks the user to confirm. If they decline, revise the order with them and call plan_schedule with action "propose" again.`;

const READY_GUIDANCE = `Ready: the schedule is agreed. Do not implement anything in plan mode. Call /plan-execute to hand off to a fresh session that carries the agreed schedule.`;

function confirmationStatus(session: PlanSession): string {
	const lines = CONFIRMATION_KINDS.map((kind) => {
		const summary = session.confirmations[kind];
		const state = summary === undefined ? "not confirmed" : `confirmed: ${summary}`;
		return `- ${CONFIRMATION_LABELS[kind]}: ${state}`;
	});
	return ["Confirmation status:", ...lines].join("\n");
}
