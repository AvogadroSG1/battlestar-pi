import { describe, expect, it } from "vitest";
import { type PlanHarness, setupPlanMode } from "./plan-mode-harness.ts";

// BDD contract for battlestar-pi-tkl.1: readiness assessment, grill-with-docs, mental-model confirmation.
// Builds on battlestar-pi-tkl.2 (plan_phase tool, plan mode lifecycle). Phases:
// readiness -> grilling | confirming -> ticketing -> reviewing -> scheduling -> ready

const GRILL = /grill/i;
const TICKET = /ticket/i;

function choose(pattern: RegExp) {
	return (_title: string, options: string[]) => options.find((o) => pattern.test(o));
}

async function inPlanMode(options: Parameters<typeof setupPlanMode>[0] = {}) {
	const h = setupPlanMode(options);
	await h.runCommand("plan", "build the thing");
	return h;
}

async function confirmBoth(h: PlanHarness) {
	await h.runTool("plan_confirm", { kind: "outcome", summary: "Users can do X; constraint Y" });
	await h.runTool("plan_confirm", { kind: "system_model", summary: "Module A talks to B via C" });
}

describe("readiness assessment", () => {
	it("explains a grill-first recommendation to the user and follows it when they agree", async () => {
		const h = await inPlanMode({ select: choose(GRILL) });

		const result = await h.runTool("plan_readiness", {
			recommendation: "grill",
			rationale: "Requirement R is ambiguous",
		});

		const [title, options] = h.select.mock.calls[0]!;
		expect(title).toContain("Requirement R is ambiguous");
		expect(options.some((o) => GRILL.test(o))).toBe(true);
		expect(options.some((o) => TICKET.test(o))).toBe(true);
		expect(result.details?.phase).toBe("grilling");
	});

	it("lets the user override a grill-first recommendation and go straight to ticketing prep", async () => {
		const h = await inPlanMode({ select: choose(TICKET) });

		const result = await h.runTool("plan_readiness", { recommendation: "grill", rationale: "unclear" });

		expect(result.details?.phase).toBe("confirming");
		expect(result.details?.recommendation).toBe("grill");
		expect(result.details?.userChoice).toBe("ticket");
	});

	it("lets the user override a ticket-first recommendation and grill anyway", async () => {
		const h = await inPlanMode({ select: choose(GRILL) });

		const result = await h.runTool("plan_readiness", { recommendation: "ticket", rationale: "well specified" });

		expect(result.details?.phase).toBe("grilling");
	});

	it("follows the recommendation when the user dismisses the choice", async () => {
		const h = await inPlanMode({ select: () => undefined });

		const result = await h.runTool("plan_readiness", { recommendation: "ticket", rationale: "well specified" });

		expect(result.details?.phase).toBe("confirming");
	});
});

describe("grilling uses the approved skills, not a separate plan mode", () => {
	it("directs the agent to /skill:grill-with-docs while grilling", async () => {
		const h = await inPlanMode({ select: choose(GRILL) });
		await h.runTool("plan_readiness", { recommendation: "grill", rationale: "unclear" });

		const context = await h.injectedContext();

		expect(context).toContain("grill-with-docs");
		expect(context).not.toMatch(/^Plan:/m); // old numbered "Plan:" generation mode is gone
	});

	it("does not mention grill-with-docs outside the grilling phase", async () => {
		const h = await inPlanMode();

		expect(await h.injectedContext()).not.toContain("grill-with-docs");
	});
});

describe("mental-model confirmation before ticketing", () => {
	it("asks the user to confirm the outcome and system model, showing each summary", async () => {
		const h = await inPlanMode();

		await h.runTool("plan_confirm", { kind: "outcome", summary: "Users can do X; constraint Y" });
		await h.runTool("plan_confirm", { kind: "system_model", summary: "Module A talks to B via C" });

		const messages = h.confirm.mock.calls.map((c) => `${c[0]} ${c[1]}`).join("\n");
		expect(messages).toContain("Users can do X; constraint Y");
		expect(messages).toContain("Module A talks to B via C");
	});

	it("refuses ticketing until BOTH models are confirmed, naming what is missing", async () => {
		const h = await inPlanMode();
		await h.runTool("plan_confirm", { kind: "outcome", summary: "Users can do X" });

		await expect(h.runTool("plan_phase", { phase: "ticketing" })).rejects.toThrow(/system[_ ]model/i);

		await h.runTool("plan_confirm", { kind: "system_model", summary: "A talks to B" });
		const result = await h.runTool("plan_phase", { phase: "ticketing" });
		expect(result.details?.phase).toBe("ticketing");
	});

	it("keeps the user in grilling when they decline a confirmation, and does not count it", async () => {
		const h = await inPlanMode({ confirm: () => false });

		const result = await h.runTool("plan_confirm", { kind: "outcome", summary: "Wrong summary" });

		expect(result.details?.confirmed).toBe(false);
		expect(result.details?.phase).toBe("grilling");
		await expect(h.runTool("plan_phase", { phase: "ticketing" })).rejects.toThrow(/outcome/i);
	});

	it("directs the agent to /skill:to-tickets once ticketing starts", async () => {
		const h = await inPlanMode();
		await confirmBoth(h);
		await h.runTool("plan_phase", { phase: "ticketing" });

		expect(await h.injectedContext()).toContain("to-tickets");
	});
});

describe("ticket drafting exposes an undecided requirement", () => {
	async function inTicketing() {
		const h = await inPlanMode();
		await confirmBoth(h);
		await h.runTool("plan_phase", { phase: "ticketing" });
		return h;
	}

	it("returns to grilling with the reason, and requires a reason", async () => {
		const h = await inTicketing();

		await expect(h.runTool("plan_phase", { phase: "grilling" })).rejects.toThrow(/reason/i);

		const result = await h.runTool("plan_phase", { phase: "grilling", reason: "auth strategy is undecided" });
		expect(result.details?.phase).toBe("grilling");
		expect(await h.injectedContext()).toContain("auth strategy is undecided");
	});

	it("requires re-confirmation and flags affected tickets for re-review on the way back", async () => {
		const h = await inTicketing();
		await h.runTool("plan_phase", { phase: "grilling", reason: "auth strategy is undecided" });

		await expect(h.runTool("plan_phase", { phase: "ticketing" })).rejects.toThrow(/outcome|system[_ ]model|confirm/i);

		await confirmBoth(h);
		const result = await h.runTool("plan_phase", { phase: "ticketing" });
		expect(result.details?.phase).toBe("ticketing");
		expect(result.details?.reReviewRequired).toBe(true);
	});
});

describe("persistence", () => {
	it("restores the phase after a resume", async () => {
		const first = await inPlanMode();
		await confirmBoth(first);
		await first.runTool("plan_phase", { phase: "ticketing" });

		const resumed = setupPlanMode({ entries: first.entries });
		await resumed.emit("session_start", {});

		expect(await resumed.injectedContext()).toContain("to-tickets");
	});

	it("restores confirmations after a resume, so only the missing one is still required", async () => {
		const first = await inPlanMode();
		await first.runTool("plan_confirm", { kind: "outcome", summary: "Users can do X" });

		const resumed = setupPlanMode({ entries: first.entries });
		await resumed.emit("session_start", {});

		await expect(resumed.runTool("plan_phase", { phase: "ticketing" })).rejects.toThrow(/system[_ ]model/i);
		await resumed.runTool("plan_confirm", { kind: "system_model", summary: "A talks to B" });
		const result = await resumed.runTool("plan_phase", { phase: "ticketing" });
		expect(result.details?.phase).toBe("ticketing");
	});
});
