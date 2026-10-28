/**
 * Ticket drafts for plan mode: validation, publication order, rendering, and publishing.
 *
 * Publishing creates one Beads epic, then one child ticket per draft in dependency order, with a
 * native `blocks` edge per blocker. Commands run through the injected `exec`, so this module does
 * not depend on the extension API. When Beads cannot create the epic (not initialized, or not
 * installed), the same tickets are written as Markdown files instead. A failure after Beads has
 * created something throws, because falling back then would duplicate tickets.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TicketEpic {
	title: string;
	outcome: string;
}

export interface TicketSkill {
	name: string;
	/** One line telling the implementor how to use this skill for this ticket. */
	guidance: string;
}

export interface DraftTicket {
	/** Short unique key that other drafts use in `blockedBy`. */
	key: string;
	title: string;
	/** The end-to-end behavior this slice makes work, from the user's perspective. */
	whatToBuild: string;
	/** Given/When/Then scenarios. The implementor turns each into a test. */
	acceptance: string[];
	/** Keys of the drafts that must complete before this one can start. */
	blockedBy: string[];
	skills: TicketSkill[];
}

export interface CommandOutput {
	stdout: string;
	stderr: string;
	code: number;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandOutput>;

export interface PublishRequest {
	exec: CommandRunner;
	epic: TicketEpic;
	drafts: DraftTicket[];
	/** Directory for the Markdown fallback. Created if missing. */
	markdownDir: string;
}

export interface PublishResult {
	tracker: "beads" | "markdown";
	/** Beads epic id, or the epic's slug for the Markdown fallback. */
	epicId: string;
	/** Draft key to created ticket id (Beads id, or Markdown file stem). */
	ticketIds: Record<string, string>;
	/** Set for the Markdown fallback: the directory the files were written to. */
	markdownDir?: string;
	/** Set for the Markdown fallback: why Beads was not used. */
	fallbackReason?: string;
}

const BDD_SCENARIO = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;

/** Returns the problems with a draft set. An empty list means the drafts can be reviewed. */
export function validateDrafts(drafts: DraftTicket[]): string[] {
	if (drafts.length === 0) return ["Draft at least one ticket."];

	const problems: string[] = [];
	const keys = new Set<string>();
	for (const ticket of drafts) {
		if (keys.has(ticket.key)) problems.push(`Ticket "${ticket.key}": duplicate key.`);
		keys.add(ticket.key);
	}

	for (const ticket of drafts) {
		const label = `Ticket "${ticket.key}"`;
		if (!ticket.title.trim()) problems.push(`${label}: title is empty.`);
		if (!ticket.whatToBuild.trim()) problems.push(`${label}: what to build is empty.`);
		if (ticket.acceptance.length === 0) {
			problems.push(`${label}: needs at least one BDD scenario (Given/When/Then).`);
		}
		for (const criterion of ticket.acceptance) {
			if (!BDD_SCENARIO.test(criterion)) {
				problems.push(
					`${label}: acceptance "${criterion}" is not a BDD scenario. Write Given ..., when ..., then ....`,
				);
			}
		}
		if (ticket.skills.length === 0) problems.push(`${label}: names no repository skill (for example tdd).`);
		for (const skill of ticket.skills) {
			if (!skill.guidance.trim()) problems.push(`${label}: skill "${skill.name}" needs loading guidance.`);
		}
		for (const blocker of ticket.blockedBy) {
			if (!keys.has(blocker)) problems.push(`${label}: blocked by unknown ticket "${blocker}".`);
		}
	}

	const cycle = findCycle(drafts);
	if (cycle) problems.push(`Dependency cycle: ${cycle.join(" -> ")}.`);
	return problems;
}

function findCycle(drafts: DraftTicket[]): string[] | undefined {
	const blockersOf = new Map(drafts.map((ticket) => [ticket.key, ticket.blockedBy]));
	const finished = new Set<string>();
	const path: string[] = [];

	const visit = (key: string): string[] | undefined => {
		const start = path.indexOf(key);
		if (start >= 0) return [...path.slice(start), key];
		if (finished.has(key)) return undefined;
		path.push(key);
		for (const blocker of blockersOf.get(key) ?? []) {
			const found = visit(blocker);
			if (found) return found;
		}
		path.pop();
		finished.add(key);
		return undefined;
	};

	for (const ticket of drafts) {
		const found = visit(ticket.key);
		if (found) return found;
	}
	return undefined;
}

/** Blockers first; otherwise the drafts keep their input order. Assumes `validateDrafts` passed. */
export function orderForPublication(drafts: DraftTicket[]): DraftTicket[] {
	const ordered: DraftTicket[] = [];
	const placed = new Set<string>();
	let pending = [...drafts];
	while (pending.length > 0) {
		const next = pending.find((ticket) => ticket.blockedBy.every((blocker) => placed.has(blocker)));
		if (!next)
			throw new Error("Cannot order tickets: a dependency cycle or unknown blocker. Validate the drafts first.");
		ordered.push(next);
		placed.add(next.key);
		pending = pending.filter((ticket) => ticket !== next);
	}
	return ordered;
}

/**
 * The ticket body shared by Beads descriptions and Markdown files. `blockerLabels` are the
 * blocker lines the caller chose (titles for Beads, `id: title` for Markdown).
 */
export function renderTicketBody(ticket: DraftTicket, blockerLabels: string[]): string {
	const blockers =
		blockerLabels.length > 0 ? blockerLabels.map((label) => `- ${label}`) : ["None (can start immediately)"];
	const skills = ticket.skills.map((skill) => `- Load /skill:${skill.name} before starting: ${skill.guidance}`);
	return [
		"## What to build",
		"",
		ticket.whatToBuild,
		"",
		"## Acceptance criteria",
		"",
		...ticket.acceptance.map((criterion) => `- [ ] ${criterion}`),
		"",
		"## Blocked by",
		"",
		...blockers,
		"",
		"## Skills",
		"",
		...skills,
		"",
	].join("\n");
}

/**
 * Creates the epic and its tickets. A failure creating the epic means Beads is unusable and
 * nothing was created, so the tickets are written as Markdown instead. A failure after that throws,
 * naming what was already created.
 */
export async function publishTickets(request: PublishRequest): Promise<PublishResult> {
	const ordered = orderForPublication(request.drafts);
	const epic = await runBd(request.exec, [
		"create",
		request.epic.title,
		"-t",
		"epic",
		"--silent",
		"-d",
		request.epic.outcome,
	]);
	const epicId = epic.stdout.trim();
	if (epic.code !== 0 || epicId === "") {
		return writeMarkdown(request.epic, ordered, request.markdownDir, failureText(epic));
	}

	const titles = new Map(ordered.map((ticket) => [ticket.key, ticket.title]));
	const created = [`${epicId} (epic)`];
	const ticketIds: Record<string, string> = {};
	for (const draft of ordered) {
		const body = renderTicketBody(
			draft,
			draft.blockedBy.map((key) => titles.get(key) ?? key),
		);
		const create = await runBd(request.exec, [
			"create",
			draft.title,
			"-t",
			"task",
			"--parent",
			epicId,
			"--silent",
			"-d",
			body,
			"--skills",
			draft.skills.map((skill) => skill.name).join(","),
		]);
		const id = create.stdout.trim();
		if (create.code !== 0 || id === "") {
			throw new Error(partialFailure(`creating "${draft.title}"`, create, created));
		}
		ticketIds[draft.key] = id;
		created.push(`${id} (${draft.title})`);

		for (const blocker of draft.blockedBy) {
			const blockerId = ticketIds[blocker];
			if (!blockerId)
				throw new Error(`Ticket "${draft.title}" is blocked by "${blocker}", which was not created first.`);
			const link = await runBd(request.exec, ["dep", "add", id, "--blocked-by", blockerId]);
			if (link.code !== 0) {
				throw new Error(partialFailure(`linking "${draft.title}" to its blocker`, link, created));
			}
		}
	}
	return { tracker: "beads", epicId, ticketIds };
}

async function runBd(exec: CommandRunner, args: string[]): Promise<CommandOutput> {
	try {
		return await exec("bd", args);
	} catch (error) {
		return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
	}
}

function failureText(output: CommandOutput): string {
	return (output.stderr || output.stdout).trim() || `exit code ${output.code}`;
}

function partialFailure(step: string, output: CommandOutput, created: string[]): string {
	return `Beads publish failed while ${step}: ${failureText(output)}. Already created: ${created.join(", ")}. Close those issues or fix Beads before publishing again.`;
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function writeMarkdown(epic: TicketEpic, ordered: DraftTicket[], dir: string, fallbackReason: string): PublishResult {
	const ids = new Map(
		ordered.map((ticket, index) => [
			ticket.key,
			`${String(index + 1).padStart(2, "0")}-${slug(ticket.title) || ticket.key}`,
		]),
	);
	const titles = new Map(ordered.map((ticket) => [ticket.key, ticket.title]));
	const labelOf = (key: string) => `${ids.get(key)}: ${titles.get(key) ?? key}`;

	const index = [
		`# ${epic.title}`,
		"",
		epic.outcome,
		"",
		"## Tickets",
		"",
		...ordered.map((ticket) => {
			const blockers =
				ticket.blockedBy.length > 0
					? `blocked by ${ticket.blockedBy.map((key) => ids.get(key)).join(", ")}`
					: "can start immediately";
			return `- ${ids.get(ticket.key)}: ${ticket.title} (${blockers})`;
		}),
		"",
	];

	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "README.md"), index.join("\n"));
	for (const ticket of ordered) {
		const id = ids.get(ticket.key);
		const body = renderTicketBody(
			ticket,
			ticket.blockedBy.map((key) => labelOf(key)),
		);
		writeFileSync(join(dir, `${id}.md`), `# ${ticket.title}\n\nID: ${id}\nStatus: open\n\n${body}`);
	}

	return {
		tracker: "markdown",
		epicId: slug(epic.title),
		ticketIds: Object.fromEntries(ids),
		markdownDir: dir,
		fallbackReason,
	};
}
