import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EXPLORE_CONTEXT_TYPE = "explore-mode-context";

type ExploreStage = "overview" | "flow";

function isInsideRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

function hasExploreContext(message: AgentMessage): boolean {
	return "customType" in message && message.customType === EXPLORE_CONTEXT_TYPE;
}

export default function exploreExtension(pi: ExtensionAPI): void {
	let stage: ExploreStage | undefined;
	let scope: string | undefined;
	let toolsBeforeExplore: string[] | undefined;
	let exitWhenSettled = false;

	function leaveExplore(ctx: ExtensionContext, abort: boolean): void {
		if (abort) ctx.abort();
		stage = undefined;
		scope = undefined;
		exitWhenSettled = false;
		if (toolsBeforeExplore !== undefined) {
			pi.setActiveTools(toolsBeforeExplore);
			toolsBeforeExplore = undefined;
		}
		ctx.ui.setStatus("explore-mode", undefined);
	}

	pi.registerCommand("explore", {
		description: "Explore the repository through an annotated architecture overview",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Explore mode requires interactive terminal mode.", "error");
				return;
			}

			if (stage !== undefined) {
				if (!ctx.isIdle()) {
					exitWhenSettled = true;
					ctx.abort();
					ctx.ui.notify("Stopping the exploration before restoring your previous tools.", "info");
					return;
				}
				leaveExplore(ctx, false);
				ctx.ui.notify("Explore mode stopped. Previous tools restored.", "info");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run to finish before starting Explore mode.", "warning");
				return;
			}

			const requestedPath = args.trim();
			const target = resolve(ctx.cwd, requestedPath || ".");
			if (!isInsideRoot(ctx.cwd, target)) {
				ctx.ui.notify("Explore mode only accepts paths inside the current repository.", "error");
				return;
			}

			scope = target;
			stage = "overview";
			toolsBeforeExplore = pi.getActiveTools();
			pi.setActiveTools(READ_ONLY_TOOLS);
			ctx.ui.setStatus("explore-mode", ctx.ui.theme.fg("warning", "explore · read-only"));
			pi.sendUserMessage(`Explore the local codebase rooted at ${JSON.stringify(target)}.`);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (stage === undefined || event.messageType !== "user") return;

		const instructions =
			stage === "overview"
				? `Create a concise ASCII architecture overview for the requested local codebase area. Identify three to five useful Flow candidates beneath it. Mark diagram notes with numbered annotations and describe them below the diagram. Use only the active read-only tools. Base claims on source you inspected, keep the survey cursory, and provide best-effort local path:line references where useful. Do not use Mermaid.`
				: `Investigate the Flow candidate requested by the user. Trace its participants and ordered interactions through the source, then show a static ASCII sequence diagram with numbered Diagram annotations below it. Draw branches that change the outcome and summarize smaller alternatives in annotations. Use only the active read-only tools and provide best-effort local path:line references where useful. Do not use Mermaid.`;

		return {
			message: {
				customType: EXPLORE_CONTEXT_TYPE,
				content: `[EXPLORE MODE ACTIVE — READ ONLY]\nRepository scope: ${JSON.stringify(scope)}\n${instructions}`,
				display: false,
			},
		};
	});

	pi.on("context", async (event) => {
		if (stage !== undefined) return;
		return { messages: event.messages.filter((message) => !hasExploreContext(message)) };
	});

	pi.on("tool_call", async (event) => {
		if (stage === undefined || READ_ONLY_TOOLS.includes(event.toolName)) return;
		return { block: true, reason: "Explore mode only allows built-in read and search tools." };
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (exitWhenSettled) {
			leaveExplore(ctx, false);
			ctx.ui.notify("Explore mode stopped. Previous tools restored.", "info");
			return;
		}
		if (event.aborted) {
			leaveExplore(ctx, false);
			ctx.ui.notify("Explore mode cancelled. Previous tools restored.", "info");
			return;
		}
		if (stage !== "overview") return;
		stage = "flow";
		ctx.ui.notify("Overview ready. Describe a Flow candidate to inspect it, or run /explore again to exit.", "info");
	});

	pi.on("session_before_switch", async (_event, ctx) => leaveExplore(ctx, false));
	pi.on("session_before_fork", async (_event, ctx) => leaveExplore(ctx, false));
	pi.on("session_shutdown", async (_event, ctx) => leaveExplore(ctx, false));
}
