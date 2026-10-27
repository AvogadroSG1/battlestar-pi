import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EXPLORE_CONTEXT_TYPE = "explore-mode-context";

type ExploreStage = "overview" | "choosing-flow" | "diagram";

interface DiagramAnnotation {
	number: number;
	title: string;
	description: string;
}

class DiagramViewer implements Component {
	private selectedIndex = 0;
	private tui: TUI;
	private theme: Theme;
	private diagram: string[];
	private annotations: DiagramAnnotation[];
	private done: (result: "flows" | "exit") => void;

	constructor(
		tui: TUI,
		theme: Theme,
		diagram: string[],
		annotations: DiagramAnnotation[],
		done: (result: "flows" | "exit") => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.diagram = diagram;
		this.annotations = annotations;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done("flows");
		} else if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done("exit");
		} else if (this.annotations.length === 0) {
			return;
		} else if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.annotations.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const annotation = this.annotations[this.selectedIndex];
		const lines = [
			this.theme.fg("accent", "Sequence diagram"),
			...this.diagram,
			"",
			this.theme.fg("muted", "Diagram annotation · ↑/↓ select · Esc flows · q exit"),
			annotation
				? this.theme.fg("accent", `[${annotation.number}] ${annotation.title}`)
				: this.theme.fg("muted", "No annotations were recognized."),
			...(annotation ? [annotation.description] : []),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}
}

function parseDiagram(text: string): { diagram: string[]; annotations: DiagramAnnotation[] } {
	const diagramText = text.match(/```[^\n]*\n([\s\S]*?)```/)?.[1];
	const annotationSection = text.match(/(?:^|\n)Diagram annotations:\s*\n([\s\S]*)$/i)?.[1] ?? "";
	const annotations = annotationSection
		.split("\n")
		.map((line) => {
			const match = line.match(/^\s*[-*]\s+\[(\d+)\]\s+(.+?)\s*$/);
			if (!match) return undefined;
			const [title, description = ""] = match[2]!.split(/\s+[—–]\s+/, 2);
			return { number: Number(match[1]), title: title!, description };
		})
		.filter((annotation): annotation is DiagramAnnotation => annotation !== undefined);
	return { diagram: (diagramText ?? "Diagram unavailable.").split("\n"), annotations };
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
	let toolsBeforeExplore: string[] | undefined;
	let exitWhenSettled = false;
	let latestAssistantText = "";

	function leaveExplore(ctx: ExtensionContext, abort: boolean): void {
		if (abort) ctx.abort();
		stage = undefined;
		scope = undefined;
		flowCandidates = [];
		latestAssistantText = "";
		exitWhenSettled = false;
		if (toolsBeforeExplore !== undefined) {
			pi.setActiveTools(toolsBeforeExplore);
			toolsBeforeExplore = undefined;
		}
		ctx.ui.setStatus("explore-mode", undefined);
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
					exitWhenSettled = true;
					ctx.abort();
					ctx.ui.notify("Stopping the exploration before restoring your previous tools.", "info");
					return;
				}
				if (args.trim().toLowerCase() === "exit") {
					leaveExplore(ctx, false);
					ctx.ui.notify("Explore mode stopped. Previous tools restored.", "info");
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
			toolsBeforeExplore = pi.getActiveTools();
			pi.setActiveTools(READ_ONLY_TOOLS);
			ctx.ui.setStatus("explore-mode", ctx.ui.theme.fg("warning", "explore · read-only"));
			pi.sendUserMessage(`Explore the local codebase rooted at ${JSON.stringify(target)}.`);
		},
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
				: `Investigate the Flow candidate requested by the user. Trace its participants and ordered interactions through the source. Return one static ASCII sequence diagram inside a single fenced code block. Follow it with a section titled exactly "Diagram annotations:" containing lines formatted exactly "- [1] Short title — explanation; source: path:line". Number annotations in diagram order. Draw branches that change the outcome and summarize smaller alternatives in annotations. Use only the active read-only tools and provide best-effort local path:line references where useful. Do not use Mermaid.`;

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

		const { diagram, annotations } = parseDiagram(latestAssistantText);
		const result = await ctx.ui.custom<"flows" | "exit">(
			(tui, theme, _keybindings, done) => new DiagramViewer(tui, theme, diagram, annotations, done),
			{ overlay: true, overlayOptions: { anchor: "center", width: 100, maxHeight: 40 } },
		);
		if (result === "exit") {
			leaveExplore(ctx, false);
			ctx.ui.notify("Explore mode stopped. Previous tools restored.", "info");
		} else if (result === "flows") {
			await chooseFlow(ctx);
		}
	});

	pi.on("session_before_switch", async (_event, ctx) => leaveExplore(ctx, false));
	pi.on("session_before_fork", async (_event, ctx) => leaveExplore(ctx, false));
	pi.on("session_shutdown", async (_event, ctx) => leaveExplore(ctx, false));
}
