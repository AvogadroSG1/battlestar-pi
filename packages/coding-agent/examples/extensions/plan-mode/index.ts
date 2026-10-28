/**
 * Plan Mode Extension
 *
 * Collaborative planning mode. While active, built-in write tools are disabled and bash is limited
 * to read-only commands from an allowlist. The workflow moves through phases (see workflow.ts). The
 * agent drives it with plan_readiness, plan_confirm, plan_phase, plan_tickets, and plan_schedule;
 * the user answers the questions those tools ask. In the fresh session, the orchestrate tool runs the tickets (see orchestration.ts).
 *
 * - /plan: start plan mode, or open the Continue/Exit menu when it is already active
 * - /plan-execute: hand off the agreed schedule to a fresh session
 * - Ctrl+Alt+P: same as /plan
 */

import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { planContext } from "./guidance.ts";
import {
	ORCHESTRATION_CONTEXT,
	ORCHESTRATION_ENTRY,
	type Orchestration,
	type OrchestrationEntry,
	orchestrateParams,
	orchestrationContext,
	orchestrationEntry,
	restoreOrchestration,
	runOrchestrate,
} from "./orchestrate.ts";
import {
	buildHandoff,
	deriveSchedule,
	HANDOFF_HEADER,
	readBeadsIssues,
	readMarkdownIssues,
	renderSchedule,
	type TrackerIssue,
	type TrackerRef,
} from "./schedule.ts";
import { type PublishResult, publishTickets, validateDrafts } from "./tickets.ts";
import { isSafeCommand } from "./utils.ts";
import {
	agreeSchedule,
	answerConfirmation,
	assertDraftsReviewable,
	assertPublishable,
	assertPublished,
	assertReadinessOpen,
	assertScheduleProposed,
	CONFIRMATION_KINDS,
	CONFIRMATION_LABELS,
	chooseReadiness,
	isPlanPhase,
	movePhase,
	PLAN_PHASES,
	type PlanModeEntry,
	type PlanSession,
	proposeSchedule,
	type ReadinessChoice,
	submitDrafts,
} from "./workflow.ts";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const WRITE_TOOLS: Record<string, true> = { edit: true, write: true };

const CONTINUE = "Continue planning";
const EXIT = "Exit Plan Mode";
const EXECUTE = "Execute and clear context";

const READINESS_CHOICES: ReadinessChoice[] = ["grill", "ticket"];
const READINESS_LABELS: Record<ReadinessChoice, string> = {
	grill: "Grill first",
	ticket: "Go straight to ticketing",
};

const TICKET_ACTIONS = ["submit_drafts", "approve", "publish"] as const;

const TICKET_DRAFT = Type.Object({
	key: Type.String({ description: "Short unique key that other drafts use in blockedBy" }),
	title: Type.String(),
	whatToBuild: Type.String({ description: "End-to-end behavior this slice makes work, from the user's perspective" }),
	acceptance: Type.Array(Type.String({ description: "BDD scenario: Given ..., when ..., then ..." })),
	blockedBy: Type.Array(Type.String({ description: "Keys of the tickets that must complete first" })),
	skills: Type.Array(
		Type.Object({
			name: Type.String({ description: "Repository skill name, without the /skill: prefix" }),
			guidance: Type.String({ description: "How the implementor uses this skill for this ticket" }),
		}),
	),
});

const ticketParams = Type.Object({
	action: StringEnum(TICKET_ACTIONS),
	epic: Type.Optional(
		Type.Object({
			title: Type.String(),
			outcome: Type.String({ description: "The desired outcome the tickets deliver" }),
		}),
	),
	drafts: Type.Optional(Type.Array(TICKET_DRAFT)),
});

const SCHEDULE_ACTIONS = ["propose", "agree"] as const;

const scheduleParams = Type.Object({ action: StringEnum(SCHEDULE_ACTIONS) });

const NOT_ACTIVE = "Plan mode is not active. Start it with /plan first.";

/** Data of the latest custom session entry of this type, if any. */
function lastEntryData<T>(ctx: ExtensionContext, customType: string): T | undefined {
	const entry = ctx.sessionManager
		.getEntries()
		.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === customType)
		.at(-1) as { data?: T } | undefined;
	return entry?.data;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let session: PlanSession | undefined;
	let orchestration: Orchestration | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("plan-mode", session ? ctx.ui.theme.fg("warning", `plan: ${session.phase}`) : undefined);
	}

	function persist(): void {
		const entry: PlanModeEntry = session
			? {
					enabled: true,
					phase: session.phase,
					toolsBeforePlanMode: session.toolsBeforePlanMode,
					confirmations: session.confirmations,
					reReviewRequired: session.reReviewRequired,
					drafts: session.drafts,
					draftsApproved: session.draftsApproved,
					published: session.published,
					scheduleProposed: session.scheduleProposed,
					scheduleAgreed: session.scheduleAgreed,
				}
			: { enabled: false };
		pi.appendEntry("plan-mode", entry);
	}

	/** Makes `next` the live session and applies its planning tool set. Does not persist. */
	function activate(ctx: ExtensionContext, next: PlanSession): void {
		session = next;
		const planTools = next.toolsBeforePlanMode.filter((name) => !WRITE_TOOLS[name]);
		pi.setActiveTools([...new Set([...planTools, ...PLAN_MODE_TOOLS])]);
		updateStatus(ctx);
	}

	/** Stores a workflow transition made by a tool, then persists it. */
	function setWorkflow(ctx: ExtensionContext, next: PlanSession): void {
		session = next;
		updateStatus(ctx);
		persist();
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		activate(ctx, {
			phase: "readiness",
			toolsBeforePlanMode: pi.getActiveTools(),
			confirmations: {},
			reReviewRequired: false,
			draftsApproved: false,
			scheduleProposed: false,
			scheduleAgreed: false,
		});
		persist();
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		if (!session) return;
		pi.setActiveTools(session.toolsBeforePlanMode);
		session = undefined;
		updateStatus(ctx);
		persist();
	}

	async function confirmExit(ctx: ExtensionContext): Promise<void> {
		const confirmed = await ctx.ui.confirm(
			"Exit plan mode?",
			"Planning ends without publishing tickets or starting implementation.",
		);
		if (confirmed) exitPlanMode(ctx);
	}

	/** Reads the tickets from the tracker that published them, and names that tracker for the handoff. */
	async function loadTracker(
		ctx: ExtensionContext,
		published: PublishResult,
	): Promise<{ issues: TrackerIssue[]; tracker: TrackerRef }> {
		if (published.tracker === "beads") {
			const issues = await readBeadsIssues(
				(command, args) => pi.exec(command, args, { cwd: ctx.cwd }),
				published.epicId,
			);
			return { issues, tracker: { kind: "beads", epicId: published.epicId } };
		}
		const dir = published.markdownDir;
		if (!dir) throw new Error("The Markdown tickets have no directory. Publish them again.");
		return { issues: readMarkdownIssues(dir), tracker: { kind: "markdown", dir } };
	}

	async function togglePlanMode(request: string, ctx: ExtensionContext): Promise<void> {
		if (session) {
			const choice = await ctx.ui.select("Plan mode", [CONTINUE, EXIT]);
			if (choice === EXIT) await confirmExit(ctx);
			return;
		}

		enterPlanMode(ctx);
		pi.sendMessage(
			{
				customType: "plan-step",
				content: `Plan mode started${request ? ` for: ${request}` : ""}.\nCurrent phase: readiness. Judge whether the request is ready for ticketing or needs grilling first, then call plan_readiness.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	pi.registerCommand("plan", {
		description: "Start plan mode, or open its Continue/Exit menu when active",
		handler: async (args, ctx) => togglePlanMode(args, ctx),
	});

	pi.registerCommand("plan-execute", {
		description: "Hand off the agreed schedule to a fresh session",
		handler: async (_args, ctx) => {
			if (session?.phase !== "ready" || !session.scheduleAgreed || !session.published) {
				ctx.ui.notify(
					"Plan is not ready: the schedule must be agreed (plan_schedule propose, then agree) before /plan-execute.",
					"error",
				);
				return;
			}
			const names = pi.getCommands().map((command) => command.name);
			const handoffAvailable = names.includes("handoff");
			if (!handoffAvailable || typeof ctx.newSession !== "function") {
				const manual = handoffAvailable ? "/new" : "/handoff";
				ctx.ui.notify(
					`Plan mode stays on: run ${manual} yourself to start the fresh session with the agreed schedule.`,
					"error",
				);
				return;
			}
			const { issues, tracker } = await loadTracker(ctx, session.published);
			const epic = session.drafts?.epic;
			const handoffText = buildHandoff({
				schedule: deriveSchedule(issues),
				issues,
				tracker,
				request: epic ? `${epic.title}: ${epic.outcome}` : "",
			});
			exitPlanMode(ctx);
			await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				withSession: async (replacement) => replacement.sendUserMessage(handoffText),
			});
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode("", ctx),
	});

	pi.registerTool({
		name: "plan_readiness",
		label: "Plan readiness",
		description:
			"Recommend whether the request can go straight to ticketing (ticket) or needs requirements discovery first (grill), with a one-line rationale. The user agrees or chooses the other path. Only in the readiness phase.",
		promptSnippet: "Recommend grilling or ticketing, and let the user agree or override",
		parameters: Type.Object({
			recommendation: StringEnum(READINESS_CHOICES),
			rationale: Type.String({ description: "One line explaining the recommendation" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!session) throw new Error(NOT_ACTIVE);
			assertReadinessOpen(session);

			const options = READINESS_CHOICES.map((choice) =>
				choice === params.recommendation ? `${READINESS_LABELS[choice]} (recommended)` : READINESS_LABELS[choice],
			);
			const picked = await ctx.ui.select(`Readiness: ${params.rationale}`, options);
			// A dismissed menu follows the recommendation.
			const userChoice =
				READINESS_CHOICES.find((choice) => picked?.startsWith(READINESS_LABELS[choice])) ?? params.recommendation;

			const next = chooseReadiness(session, userChoice);
			setWorkflow(ctx, next);
			return {
				content: [{ type: "text", text: `Readiness: ${userChoice}. Plan phase: ${next.phase}` }],
				details: { phase: next.phase, recommendation: params.recommendation, userChoice },
			};
		},
	});

	pi.registerTool({
		name: "plan_confirm",
		label: "Plan confirm",
		description:
			"Ask the user to confirm one shared understanding before ticketing: the desired outcome and constraints (outcome), or the system and domain model (system_model). A declined summary sends the workflow back to grilling.",
		promptSnippet: "Ask the user to confirm the desired outcome or the system model",
		parameters: Type.Object({
			kind: StringEnum(CONFIRMATION_KINDS),
			summary: Type.String({ description: "Short summary the user confirms or declines" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!session) throw new Error(NOT_ACTIVE);

			const confirmed = await ctx.ui.confirm(
				`Confirm the ${CONFIRMATION_LABELS[params.kind]}`,
				`${params.summary}\n\nIs this right?`,
			);
			const next = answerConfirmation(session, params.kind, params.summary, confirmed);
			setWorkflow(ctx, next);
			const text = confirmed
				? `Confirmed the ${CONFIRMATION_LABELS[params.kind]}.`
				: `Not confirmed: back to grilling. Plan phase: ${next.phase}`;
			return {
				content: [{ type: "text", text }],
				details: { phase: next.phase, kind: params.kind, confirmed },
			};
		},
	});

	pi.registerTool({
		name: "plan_phase",
		label: "Plan phase",
		description: `Move the plan workflow to a phase. Known phases: ${PLAN_PHASES.join(", ")}. Ticketing needs both confirmations from plan_confirm. Returning to grilling needs a reason. reviewing and scheduling are reached only through plan_tickets, and ready only through plan_schedule agree.`,
		promptSnippet: "Move plan mode to a workflow phase",
		parameters: Type.Object({
			phase: Type.String({ description: "Workflow phase to move to" }),
			reason: Type.Optional(
				Type.String({
					description: "Required when returning to grilling: the requirement that is still undecided",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!session) throw new Error("Plan mode is not active. Start it with /plan first.");
			if (!isPlanPhase(params.phase)) {
				throw new Error(`Unknown plan phase "${params.phase}". Known phases: ${PLAN_PHASES.join(", ")}.`);
			}
			const next = movePhase(session, params.phase, params.reason);
			setWorkflow(ctx, next);
			return {
				content: [{ type: "text", text: `Plan phase: ${next.phase}` }],
				details: { phase: next.phase, reReviewRequired: next.reReviewRequired },
			};
		},
	});

	pi.registerTool({
		name: "plan_tickets",
		label: "Plan tickets",
		description:
			"Draft, approve, and publish dependency-aware tickets. submit_drafts (in ticketing or reviewing) takes epic and drafts and moves to reviewing. approve asks the user to confirm the drafts. publish (in reviewing, approved, with no pending re-review) creates a Beads epic with child tickets and blocker edges, or Markdown files in tickets/ if Beads is unusable, then moves to scheduling, where plan_schedule proposes the order.",
		promptSnippet: "Submit ticket drafts for review, get the user's approval, and publish them",
		parameters: ticketParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!session) throw new Error(NOT_ACTIVE);
			switch (params.action) {
				case "submit_drafts": {
					if (!params.epic || !params.drafts) throw new Error("submit_drafts needs epic and drafts.");
					const problems = validateDrafts(params.drafts);
					if (problems.length > 0) {
						throw new Error(`Drafts are not ready:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
					}
					const next = submitDrafts(session, { epic: params.epic, tickets: params.drafts });
					setWorkflow(ctx, next);
					return {
						content: [
							{
								type: "text",
								text: `Drafted ${params.drafts.length} tickets for "${params.epic.title}". Plan phase: reviewing. Ask the user whether the granularity is right (too coarse or too fine) and whether each blocker is a real dependency. Revise with submit_drafts until they agree, then call plan_tickets with action approve.`,
							},
						],
						details: { phase: next.phase, approved: false, tickets: params.drafts.length },
					};
				}
				case "approve": {
					const drafts = assertDraftsReviewable(session);
					const list = drafts.tickets.map(
						(ticket) =>
							`- ${ticket.title}${ticket.blockedBy.length > 0 ? ` (blocked by ${ticket.blockedBy.join(", ")})` : ""}`,
					);
					const approved = await ctx.ui.confirm("Approve the tickets?", [drafts.epic.title, ...list].join("\n"));
					setWorkflow(ctx, { ...session, draftsApproved: approved });
					const text = approved
						? "Tickets approved. Call plan_tickets with action publish."
						: "Not approved. Revise the drafts with submit_drafts.";
					return { content: [{ type: "text", text }], details: { phase: session.phase, approved } };
				}
				case "publish": {
					const drafts = assertPublishable(session);
					const result = await publishTickets({
						exec: (command, args) => pi.exec(command, args, { cwd: ctx.cwd }),
						epic: drafts.epic,
						drafts: drafts.tickets,
						markdownDir: join(ctx.cwd, "tickets"),
					});
					if (result.tracker === "markdown") {
						ctx.ui.notify(
							`Beads is unusable (${result.fallbackReason}). Wrote the tickets as Markdown to ${result.markdownDir}.`,
							"warning",
						);
					}
					setWorkflow(ctx, {
						...session,
						phase: "scheduling",
						published: result,
						scheduleProposed: false,
						scheduleAgreed: false,
					});
					return {
						content: [
							{
								type: "text",
								text: `Published ${Object.keys(result.ticketIds).length} tickets to ${result.tracker}. Plan phase: scheduling.`,
							},
						],
						details: {
							phase: "scheduling",
							tracker: result.tracker,
							epicId: result.epicId,
							ticketIds: result.ticketIds,
						},
					};
				}
			}
		},
	});

	pi.registerTool({
		name: "plan_schedule",
		label: "Plan schedule",
		description:
			"Propose or agree the execution schedule for the published tickets. propose reads each ticket's status and blocker edges from the tracker and shows the ordering in waves, with the tickets that can run in parallel. agree asks the user to confirm the proposed schedule; a declined agreement keeps the plan in scheduling. Only an agreed schedule reaches ready.",
		promptSnippet: "Propose the execution order from the tracker, and ask the user to agree it",
		parameters: scheduleParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!session) throw new Error(NOT_ACTIVE);
			switch (params.action) {
				case "propose": {
					const published = assertPublished(session);
					const next = proposeSchedule(session);
					const { issues } = await loadTracker(ctx, published);
					const schedule = deriveSchedule(issues);
					setWorkflow(ctx, next);
					return {
						content: [
							{
								type: "text",
								text: `${renderSchedule(schedule, issues)}\n\nSchedule proposed. Ask the user to agree it, then call plan_schedule with action agree.`,
							},
						],
						details: {
							phase: "scheduling",
							agreed: false,
							tracker: published.tracker,
							epicId: published.epicId,
							ticketIds: schedule.waves.flatMap((wave) => wave.ticketIds),
						},
					};
				}
				case "agree": {
					assertScheduleProposed(session);
					const { issues } = await loadTracker(ctx, assertPublished(session));
					const agreed = await ctx.ui.confirm(
						"Agree the execution schedule?",
						renderSchedule(deriveSchedule(issues), issues),
					);
					if (!agreed) {
						return {
							content: [
								{
									type: "text",
									text: "Schedule not agreed. Revise the ordering with the user, then call plan_schedule with action propose again.",
								},
							],
							details: { phase: "scheduling", agreed: false },
						};
					}
					setWorkflow(ctx, agreeSchedule(session));
					return {
						content: [
							{
								type: "text",
								text: "Schedule agreed. Plan phase: ready. The user runs /plan-execute to hand off.",
							},
						],
						details: { phase: "ready", agreed: true },
					};
				}
			}
		},
	});

	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description:
			"Run the handed-off plan tickets. init takes the open tickets of the approved schedule (id and blockedBy) and the tracker. Then red_contract (the failing BDD test for a ticket), dispatch, help, submit_work, review (findings), framing (joint framing outcome), arbitration, close (verified work, closed in the tracker), and status. Every result lists the ready tickets and the next step.",
		promptSnippet: "Dispatch, verify, and close the plan's tickets in dependency order",
		parameters: orchestrateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const outcome = await runOrchestrate(orchestration, params, (command, args) =>
				pi.exec(command, args, { cwd: ctx.cwd }),
			);
			orchestration = outcome.orchestration;
			pi.appendEntry(ORCHESTRATION_ENTRY, orchestrationEntry(orchestration));
			return outcome.result;
		},
	});

	// Block non-allowlisted bash commands while planning
	pi.on("tool_call", async (event) => {
		if (!session || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Exit plan mode with /plan first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode. Each prompt adds one orchestration
	// rules message, so only the newest one is kept.
	pi.on("context", async (event) => {
		if (session) return;

		const newestRules = event.messages
			.map((m) => (m as AgentMessage & { customType?: string }).customType)
			.lastIndexOf(ORCHESTRATION_CONTEXT);
		return {
			messages: event.messages.filter((m, index) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.customType === ORCHESTRATION_CONTEXT) return index === newestRules;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject the plan mode context before a user prompt. Runs started by custom messages, such as
	// background task notifications, skip it: the context from the last prompt is still in the
	// conversation, and adding it again on every notification would only repeat it.
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		if (session) {
			return { message: { customType: "plan-mode-context", content: planContext(session), display: false } };
		}
		// Outside plan mode, the orchestration rules go to an active orchestration, and to the handoff
		// prompt that starts the fresh session which runs it.
		if (!orchestration && !event.prompt.startsWith(HANDOFF_HEADER)) return;
		return { message: { customType: ORCHESTRATION_CONTEXT, content: orchestrationContext(), display: false } };
	});

	// Offer execution once the plan is ready, at the end of the agent turn
	pi.on("agent_end", async (_event, ctx) => {
		if (!session || session.phase !== "ready" || !session.scheduleAgreed || !ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan mode - what next?", [EXECUTE, CONTINUE, EXIT]);
		if (choice === EXECUTE) {
			pi.sendUserMessage("/plan-execute", { expandPromptTemplates: true });
		} else if (choice === EXIT) {
			await confirmExit(ctx);
		}
	});

	// Restore orchestration, plan mode, its phase, and its confirmations on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		const orchestrationData = lastEntryData<OrchestrationEntry>(ctx, ORCHESTRATION_ENTRY);
		orchestration = orchestrationData ? restoreOrchestration(orchestrationData) : undefined;

		const data = lastEntryData<PlanModeEntry>(ctx, "plan-mode");
		if (data?.enabled) {
			activate(ctx, {
				phase: isPlanPhase(data.phase) ? data.phase : "readiness",
				toolsBeforePlanMode: data.toolsBeforePlanMode ?? [
					...new Set([...NORMAL_MODE_TOOLS, ...pi.getActiveTools()]),
				],
				confirmations: data.confirmations ?? {},
				reReviewRequired: data.reReviewRequired ?? false,
				drafts: data.drafts,
				draftsApproved: data.draftsApproved ?? false,
				published: data.published,
				scheduleProposed: data.scheduleProposed ?? false,
				scheduleAgreed: data.scheduleAgreed ?? false,
			});
			return;
		}

		// A session without an enabled entry must not inherit the previous session's tool restriction
		if (session) pi.setActiveTools(session.toolsBeforePlanMode);
		session = undefined;
		if (pi.getFlag("plan") === true) {
			enterPlanMode(ctx);
		} else {
			updateStatus(ctx);
		}
	});
}
