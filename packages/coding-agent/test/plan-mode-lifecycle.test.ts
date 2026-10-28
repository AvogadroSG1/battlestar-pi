import { describe, expect, it } from "vitest";
import { fakeBd } from "./plan-mode-fake-bd.ts";
import { setupPlanMode } from "./plan-mode-harness.ts";

// BDD contract for battlestar-pi-tkl.2: plan-mode entry, lifecycle, and exit choices.

const EXIT = "Exit Plan Mode";
const EXECUTE = "Execute and clear context";

function pick(label: string) {
	return (_title: string, options: string[]) => options.find((o) => o === label) ?? options[0];
}

describe("plan mode lifecycle", () => {
	describe("given a user invokes /plan", () => {
		it("enters plan mode: write tools off, status shown, custom tools preserved", async () => {
			const h = setupPlanMode({ activeTools: ["read", "bash", "edit", "write", "custom_tool"] });

			await h.runCommand("plan", "add dark mode");

			expect(h.activeTools()).not.toContain("edit");
			expect(h.activeTools()).not.toContain("write");
			expect(h.activeTools()).toContain("custom_tool");
			expect(String(h.lastStatus())).toContain("plan");
		});

		it("presents the first planning step to the agent, carrying the user's request", async () => {
			const h = setupPlanMode();

			await h.runCommand("plan", "add dark mode");

			expect(h.sendMessage).toHaveBeenCalledTimes(1);
			const [message, options] = h.sendMessage.mock.calls[0]!;
			expect(message.customType).toBe("plan-step");
			expect(message.display).toBe(true);
			expect(String(message.content)).toContain("add dark mode");
			expect(options?.triggerTurn).toBe(true);
		});

		it("still blocks non-allowlisted bash while planning", async () => {
			const h = setupPlanMode();
			await h.runCommand("plan");

			const [blocked] = await h.emit("tool_call", { toolName: "bash", input: { command: "rm -rf build" } });
			const [allowed] = await h.emit("tool_call", { toolName: "bash", input: { command: "ls -la" } });

			expect((blocked as { block?: boolean }).block).toBe(true);
			expect(allowed).toBeUndefined();
		});
	});

	describe("given plan mode is active", () => {
		it("stays in plan mode across agent turns without prompting or restoring tools", async () => {
			const h = setupPlanMode();
			await h.runCommand("plan", "x");
			h.setActiveTools.mockClear();

			await h.triggerAgentEnd("Here is a question for you");
			await h.triggerAgentEnd("Here is another");
			await h.triggerAgentEnd("Drafting tickets now");

			expect(h.select).not.toHaveBeenCalled();
			expect(h.setActiveTools).not.toHaveBeenCalled();
			expect(h.activeTools()).not.toContain("write");
			expect(String(h.lastStatus())).toContain("plan");
		});

		it("injects plan-mode context into user prompts while active and nothing after exit", async () => {
			const h = setupPlanMode({ select: pick(EXIT) });
			await h.runCommand("plan", "x");
			expect(await h.injectedContext()).toContain("PLAN MODE ACTIVE");

			await h.runCommand("plan");
			expect(await h.injectedContext()).not.toContain("PLAN MODE ACTIVE");
		});

		it("rejects unknown workflow phases and accepts known ones, reporting the phase", async () => {
			const h = setupPlanMode();
			await h.runCommand("plan", "x");

			await expect(h.runTool("plan_phase", { phase: "bogus" })).rejects.toThrow(/phase/i);
			const result = await h.runTool("plan_phase", { phase: "grilling" });
			expect(result.details?.phase).toBe("grilling");
			await expect(h.runTool("plan_phase", { phase: "ready" })).rejects.toThrow(/plan_schedule agree/);
		});
	});

	describe("given the user chooses Exit Plan Mode", () => {
		it("offers Continue/Exit on /plan, and exit restores tools and clears status without starting anything", async () => {
			const h = setupPlanMode({ select: pick(EXIT) });
			await h.runCommand("plan", "x");
			h.sendMessage.mockClear();

			await h.runCommand("plan");

			const options = h.select.mock.calls[0]![1];
			expect(options).toContain(EXIT);
			expect(options).not.toContain(EXECUTE); // no approved schedule yet
			expect(h.activeTools()).toEqual(expect.arrayContaining(["edit", "write"]));
			expect(h.lastStatus()).toBeUndefined();
			expect(h.sendMessage).not.toHaveBeenCalled();
			expect(h.sendUserMessage).not.toHaveBeenCalled();
			expect(h.newSession).not.toHaveBeenCalled();
		});

		it("stays in plan mode when the exit is not confirmed or the menu is dismissed", async () => {
			const declined = setupPlanMode({ select: pick(EXIT), confirm: () => false });
			await declined.runCommand("plan", "x");
			await declined.runCommand("plan");
			expect(declined.activeTools()).not.toContain("write");

			const dismissed = setupPlanMode({ select: () => undefined });
			await dismissed.runCommand("plan", "x");
			await dismissed.runCommand("plan");
			expect(dismissed.activeTools()).not.toContain("write");
		});
	});

	describe("given the user chooses Execute and clear context", () => {
		async function readyHarness(options: Parameters<typeof setupPlanMode>[0] = {}) {
			const bd = fakeBd();
			const h = setupPlanMode({ select: pick(EXECUTE), exec: bd.exec, ...options });
			await h.runCommand("plan", "x");
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

		it("offers Execute only once the schedule is ready, at the end of the agent turn", async () => {
			const h = await readyHarness();

			await h.triggerAgentEnd("Schedule agreed.");

			expect(h.select).toHaveBeenCalledTimes(1);
			const [title, options] = h.select.mock.calls[0]!;
			expect(title).toMatch(/plan mode/i);
			expect(options).toEqual(expect.arrayContaining([EXECUTE, EXIT]));
		});

		it("dispatches /plan-execute as a command, which exits plan mode", async () => {
			const h = await readyHarness();

			await h.triggerAgentEnd("Schedule agreed.");

			expect(h.sendUserMessage).toHaveBeenCalledWith(
				"/plan-execute",
				expect.objectContaining({ expandPromptTemplates: true }),
			);

			await h.runCommand("plan-execute");

			expect(h.activeTools()).toEqual(expect.arrayContaining(["edit", "write"]));
			expect(h.lastStatus()).toBeUndefined();
			expect(h.appendEntry).toHaveBeenCalledWith("plan-mode", expect.objectContaining({ enabled: false }));
		});

		it("refuses /plan-execute before the schedule is ready and stays in plan mode", async () => {
			const h = setupPlanMode();
			await h.runCommand("plan", "x");

			await h.runCommand("plan-execute");

			expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/ready|schedule/i), "error");
			expect(h.activeTools()).not.toContain("write");
		});
	});

	describe("given a session is resumed", () => {
		it("restores plan mode and its workflow phase from the persisted entry", async () => {
			const h = setupPlanMode({
				entries: [
					{
						type: "custom",
						customType: "plan-mode",
						data: {
							enabled: true,
							phase: "ready",
							scheduleAgreed: true,
							toolsBeforePlanMode: ["read", "bash", "edit", "write"],
						},
					},
				],
			});

			await h.emit("session_start", {});

			expect(h.activeTools()).not.toContain("write");
			expect(String(h.lastStatus())).toContain("plan");
			await h.triggerAgentEnd("resumed");
			expect(h.select).toHaveBeenCalledTimes(1); // phase "ready" survived the resume
		});
	});
});
