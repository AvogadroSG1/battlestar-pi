import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandOutput, CommandRunner } from "./tickets.ts";

export interface TrackerIssue {
	id: string;
	title: string;
	status: string;
	blockedBy: string[];
}

export interface ScheduleWave {
	index: number;
	ticketIds: string[];
	parallel: boolean;
}

export interface Schedule {
	waves: ScheduleWave[];
	ready: string[];
}

export type TrackerRef = { kind: "beads"; epicId: string; root: string } | { kind: "markdown"; dir: string };

interface BeadsRow {
	id: string;
	title: string;
	status: string;
	dependencies?: { depends_on_id: string; type: string }[];
}

/**
 * Layers open tickets into waves: wave 0 holds tickets whose open blockers are none, and each later
 * wave holds tickets whose blockers all sit in earlier waves or are closed.
 */
export function deriveSchedule(issues: TrackerIssue[]): Schedule {
	const known = new Set(issues.map((issue) => issue.id));
	const done = new Set(issues.filter((issue) => issue.status === "closed").map((issue) => issue.id));
	let remaining = issues.filter((issue) => !done.has(issue.id));

	for (const issue of remaining) {
		for (const blocker of issue.blockedBy) {
			if (!known.has(blocker))
				throw new Error(`Ticket ${issue.id} is blocked by ${blocker}, which is not in the tracker`);
		}
	}

	const waves: ScheduleWave[] = [];
	while (remaining.length > 0) {
		const layer = remaining.filter((issue) => issue.blockedBy.every((blocker) => done.has(blocker)));
		if (layer.length === 0) {
			throw new Error(`Dependency cycle among tickets: ${remaining.map((issue) => issue.id).join(", ")}`);
		}
		const ticketIds = layer.map((issue) => issue.id);
		waves.push({ index: waves.length, ticketIds, parallel: ticketIds.length > 1 });
		for (const id of ticketIds) done.add(id);
		remaining = remaining.filter((issue) => !done.has(issue.id));
	}

	return { waves, ready: waves[0]?.ticketIds ?? [] };
}

export function renderSchedule(schedule: Schedule, issues: TrackerIssue[]): string {
	const titles = new Map(issues.map((issue) => [issue.id, issue.title]));
	const lines: string[] = [];
	for (const wave of schedule.waves) {
		lines.push(`Wave ${wave.index}${wave.parallel ? " (parallel)" : ""}`);
		for (const id of wave.ticketIds) lines.push(`  - ${id}: ${titles.get(id) ?? id}`);
		lines.push("");
	}
	return lines.join("\n");
}

export async function readBeadsIssues(exec: CommandRunner, epicId: string): Promise<TrackerIssue[]> {
	const output: CommandOutput = await exec("bd", ["list", "--parent", epicId, "--all", "--json"]);
	if (output.code !== 0) {
		throw new Error(`bd list failed: ${(output.stderr || output.stdout).trim() || `exit code ${output.code}`}`);
	}
	const rows = JSON.parse(output.stdout) as BeadsRow[];
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		status: row.status,
		blockedBy: (row.dependencies ?? []).filter((dep) => dep.type === "blocks").map((dep) => dep.depends_on_id),
	}));
}

/**
 * Reads the Markdown tracker pinned by tickets.ts writeMarkdown: "# Title", "ID:", "Status:", and a
 * "## Blocked by" list of "- <id>: <title>" lines.
 */
export function readMarkdownIssues(dir: string): TrackerIssue[] {
	const files = readdirSync(dir).filter((file) => file.endsWith(".md") && file !== "README.md");
	return files.sort().map((file) => {
		const text = readFileSync(join(dir, file), "utf8");
		const blockedSection = /^## Blocked by\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
		const blockedBy = blockedSection
			.split("\n")
			.map((line) => /^- (.+)$/.exec(line)?.[1])
			.filter((label): label is string => label !== undefined && !label.startsWith("None ("))
			.map((label) => label.split(": ")[0] ?? label);
		return {
			id: file.slice(0, -".md".length),
			title: /^# (.+)$/m.exec(text)?.[1]?.trim() ?? file,
			status: /^Status: (\S+)$/m.exec(text)?.[1] ?? "open",
			blockedBy,
		};
	});
}

/** First line of the handoff message. The orchestration rules are injected for a prompt that starts with it. */
export const HANDOFF_HEADER = "PLAN HANDOFF";

export function buildHandoff(input: {
	schedule: Schedule;
	issues: TrackerIssue[];
	tracker: TrackerRef;
	request: string;
}): string {
	const location =
		input.tracker.kind === "beads"
			? `Beads epic ${input.tracker.epicId} in ${input.tracker.root}`
			: `Markdown directory ${input.tracker.dir}`;
	const open = input.issues.filter((issue) => issue.status !== "closed");
	const init = {
		action: "init",
		tickets: open.map((issue) => ({ id: issue.id, blockedBy: issue.blockedBy })),
		tracker:
			input.tracker.kind === "beads"
				? { kind: "beads", root: input.tracker.root }
				: { kind: "markdown", dir: input.tracker.dir },
	};
	return [
		HANDOFF_HEADER,
		"",
		"Request",
		input.request,
		"",
		"Tracker",
		`Kind: ${input.tracker.kind}`,
		`Location: ${location}`,
		"",
		"Approved schedule",
		"The schedule below is already approved by the user and must not be re-approved.",
		"",
		renderSchedule(input.schedule, input.issues),
		"Ticket references",
		...input.issues.map((issue) => `- ${issue.id}: ${issue.title}`),
		"",
		"Orchestration init",
		"Call the orchestrate tool with these arguments, unchanged. The schedule needs no further approval from the user.",
		"```json",
		JSON.stringify(init, null, "\t"),
		"```",
		"",
		"Next step",
		"Call orchestrate with action init and the arguments above, then dispatch the ready tickets (wave 0 above). Dispatch independent ready tickets in parallel.",
		"",
	].join("\n");
}
