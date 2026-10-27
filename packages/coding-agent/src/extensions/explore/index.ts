import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EXPLORE_CONTEXT_TYPE = "explore-mode-context";

type ExploreStage = "overview" | "choosing-flow" | "diagram";

interface DiagramAnnotation {
	number: number;
	title: string;
	description: string;
}

function parseDiagram(text: string): DiagramAnnotation[] {
	const annotationSection = text.match(/(?:^|\n)Diagram annotations:\s*\n([\s\S]*)$/i)?.[1] ?? "";
	return annotationSection
		.split("\n")
		.map((line) => {
			const match = line.match(/^\s*[-*]\s+\[(\d+)\]\s+(.+?)\s*$/);
			if (!match) return undefined;
			const [title, description = ""] = match[2]!.split(/\s+[—–]\s+/, 2);
			return { number: Number(match[1]), title: title!, description };
		})
		.filter((annotation): annotation is DiagramAnnotation => annotation !== undefined);
}

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

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getFlowCandidates(text: string): string[] {
	const section = text.match(/(?:^|\n)Flow candidates:\s*\n([\s\S]*?)(?=\n\s*\n|$)/i)?.[1];
	if (!section) return [];
	return section
		.split("\n")
		.map((line) => line.match(/^\s*[-*]\s+\[Flow\]\s+(.+?)\s*$/)?.[1])
		.filter((candidate): candidate is string => candidate !== undefined)
		.slice(0, 5);
}

export default function exploreExtension(pi: ExtensionAPI): void {
	let stage: ExploreStage | undefined;
	let scope: string | undefined;
	let flowCandidates: string[] = [];
	let annotations: DiagramAnnotation[] = [];
	let selectedAnnotation = 0;
	let toolsBeforeExplore: string[] | undefined;
	let exitWhenSettled = false;
	let latestAssistantText = "";

	function leaveExplore(ctx: ExtensionContext, abort: boolean): void {
		if (abort) ctx.abort();
		stage = undefined;
		scope = undefined;
		flowCandidates = [];
		annotations = [];
		selectedAnnotation = 0;
		latestAssistantText = "";
		exitWhenSettled = false;
		if (toolsBeforeExplore !== undefined) {
			pi.setActiveTools(toolsBeforeExplore);
			toolsBeforeExplore = undefined;
		}
		ctx.ui.setStatus("explore-mode", undefined);
		ctx.ui.setWidget("explore-annotation", undefined);
	}

	function showSelectedAnnotation(ctx: ExtensionContext): void {
		const annotation = annotations[selectedAnnotation];
		if (!annotation) {
			ctx.ui.setWidget("explore-annotation", [
				"Explore · no diagram annotations were recognized.",
				"Use /explore to choose another Flow or /explore exit to leave.",
			]);
			return;
		}
		ctx.ui.setWidget("explore-annotation", [
			`Explore annotation ${selectedAnnotation + 1}/${annotations.length} · /explore next | previous`,
			`[${annotation.number}] ${annotation.title}`,
			annotation.description,
		]);
	}

	function navigateAnnotation(ctx: ExtensionContext, direction: -1 | 1): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current Explore step to finish before navigating annotations.", "warning");
			return;
		}
		if (stage !== "diagram" || annotations.length === 0) {
			ctx.ui.notify("No diagram annotations are available to navigate.", "info");
			return;
		}
		selectedAnnotation = Math.max(0, Math.min(annotations.length - 1, selectedAnnotation + direction));
		showSelectedAnnotation(ctx);
	}

	pi.registerCommand("explore", {
		description: "Explore the repository and inspect a flow with an ASCII sequence diagram",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Explore mode requires interactive terminal mode.", "error");
				return;
			}

			if (stage !== undefined) {
				if (!ctx.isIdle()) {
					if (args.trim().toLowerCase() !== "exit") {
						ctx.ui.notify("Wait for the current Explore step to finish.", "warning");
						return;
					}
					exitWhenSettled = true;
					ctx.abort();
					ctx.ui.notify("Stopping Explore and restoring your previous tools.", "info");
					return;
				}
				const action = args.trim().toLowerCase();
				if (action === "exit") {
					leaveExplore(ctx, false);
					ctx.ui.notify("Explore mode stopped. Previous tools restored.", "info");
					return;
				}
				if (action === "next") {
					navigateAnnotation(ctx, 1);
					return;
				}
				if (action === "previous" || action === "prev") {
					navigateAnnotation(ctx, -1);
					return;
				}
				if (action !== "" && action !== "flow") {
					stage = "diagram";
					pi.sendUserMessage(`Inspect this Flow candidate: ${args.trim()}`);
					return;
				}
				await chooseFlow(ctx);
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
			flowCandidates = [];
			annotations = [];
			toolsBeforeExplore = pi.getActiveTools();
			pi.setActiveTools(READ_ONLY_TOOLS);
			ctx.ui.setStatus("explore-mode", ctx.ui.theme.fg("warning", "explore · read-only"));
			pi.sendUserMessage(`Explore the local codebase rooted at ${JSON.stringify(target)}.`);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("up"), {
		description: "Previous Explore diagram annotation",
		handler: (ctx) => navigateAnnotation(ctx, -1),
	});
	pi.registerShortcut(Key.ctrlAlt("down"), {
		description: "Next Explore diagram annotation",
		handler: (ctx) => navigateAnnotation(ctx, 1),
	});

	async function chooseFlow(ctx: ExtensionContext): Promise<void> {
		if (flowCandidates.length === 0) {
			ctx.ui.notify(
				"No Flow candidates were recognized. Describe a Flow in your next message, or run /explore exit.",
				"warning",
			);
			stage = "diagram";
			return;
		}

		stage = "choosing-flow";
		const choice = await ctx.ui.select("Choose a Flow to inspect", flowCandidates);
		if (!choice || stage === undefined) {
			if (stage !== undefined) stage = "diagram";
			return;
		}
		stage = "diagram";
		pi.sendUserMessage(`Inspect this Flow candidate: ${choice}`);
	}

	pi.on("before_agent_start", async (event) => {
		if (stage === undefined || event.messageType !== "user") return;

		const instructions =
			stage === "overview"
				? `Create a concise ASCII architecture overview for the requested local codebase area. Follow it with a section titled exactly "Flow candidates:" containing three to five lines formatted exactly "- [Flow] Short name — brief description". Mark architecture diagram notes with numbered annotations and describe them below the diagram. Use only the active read-only tools. Base claims on source you inspected, keep the survey cursory, and provide best-effort local path:line references where useful. Do not use Mermaid.`
				: `Investigate the Flow candidate requested by the user. Trace its participants and ordered interactions through the source. Return one static ASCII sequence diagram inside a single fenced code block. Keep every diagram line under 80 characters by using short participant labels and concise messages. Follow it with a section titled exactly "Diagram annotations:" containing lines formatted exactly "- [1] Short title — explanation; source: path:line". Number annotations in diagram order. Draw branches that change the outcome and summarize smaller alternatives in annotations. Use only the active read-only tools and provide best-effort local path:line references where useful. Do not use Mermaid.`;

		return {
			message: {
				customType: EXPLORE_CONTEXT_TYPE,
				content: `[EXPLORE MODE ACTIVE — READ ONLY]\nRepository scope: ${JSON.stringify(scope)}\n${instructions}`,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (event) => {
		if (stage !== "overview" && stage !== "diagram") return;
		const finalMessage = [...event.messages].reverse().find(isAssistantMessage);
		latestAssistantText = finalMessage ? getTextContent(finalMessage) : "";
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
		if (stage === "overview") {
			flowCandidates = getFlowCandidates(latestAssistantText);
			stage = "diagram";
			ctx.ui.notify("Overview ready. Choose a Flow with /explore, or run /explore exit to leave.", "info");
			return;
		}
		if (stage !== "diagram" || flowCandidates.length === 0) return;
		annotations = parseDiagram(latestAssistantText);
		selectedAnnotation = 0;
		showSelectedAnnotation(ctx);
		ctx.ui.notify(
			"Sequence diagram is in the transcript. Use /explore next or /explore previous to navigate annotations.",
			"info",
		);
	});

	pi.on("session_before_switch", async (_event, ctx) => leaveExplore(ctx, false));
	pi.on("session_before_fork", async (_event, ctx) => leaveExplore(ctx, false));
	pi.on("session_shutdown", async (_event, ctx) => leaveExplore(ctx, false));
}
