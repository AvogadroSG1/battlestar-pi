/**
 * Chooses the tracker for a plan's tickets at publish: Beads at the git root, or the Markdown tracker
 * (GLOSSARY: Tracker, Markdown tracker). An existing Beads database wins. Without one, the user is
 * asked once to initialize it; declining records a Beads opt-out for that repository in the harness's
 * global config (GLOSSARY: Beads opt-out), so the next publish there does not ask again.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type CommandOutput, failureText } from "./tickets.ts";

/** Runs `command` in `cwd`. A missing binary comes back as a non-zero `code`, as pi.exec reports it. */
export type CwdCommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandOutput>;

export type TrackerChoice = { kind: "beads"; root: string } | { kind: "markdown"; reason: string };

export interface TrackerChoiceRequest {
	run: CwdCommandRunner;
	cwd: string;
	/** Whether the user can answer a prompt. When false, the choice never asks and never records an opt-out. */
	canAsk: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
}

interface OptOutFile {
	repos: string[];
}

/** The git root of `cwd`, with symlinks resolved. Undefined outside a git repository. */
export async function gitRootOf(run: CwdCommandRunner, cwd: string): Promise<string | undefined> {
	const output = await runSafely(run, "git", ["rev-parse", "--show-toplevel"], cwd);
	const root = output.stdout.trim();
	if (output.code !== 0 || root === "") return undefined;
	return realpathSync(root);
}

export async function chooseTracker(request: TrackerChoiceRequest): Promise<TrackerChoice> {
	const root = await gitRootOf(request.run, request.cwd);
	if (!root) return { kind: "markdown", reason: "the working directory is not inside a git repository" };

	const version = await runSafely(request.run, "bd", ["--version"], root);
	if (version.code !== 0) {
		return { kind: "markdown", reason: "bd is not installed. Install it with `brew install beads`" };
	}

	const where = await runSafely(request.run, "bd", ["where"], root);
	if (where.code === 0) return { kind: "beads", root };

	const optedOut = { kind: "markdown" as const, reason: `Beads opt-out recorded for ${root}` };
	if (readOptOuts().includes(root)) return optedOut;
	if (!request.canAsk) {
		return { kind: "markdown", reason: `no Beads database at ${root}, and this session cannot ask to create one` };
	}

	const accepted = await request.confirm(
		"Set up Beads for this repository?",
		`${root} has no Beads database. Accepting runs \`bd init --non-interactive --init-if-missing\` there and stores the tickets in Beads. Declining keeps them in Markdown and this repository is not asked again. To undo a decline, remove its entry from ${optOutPath()}.`,
	);
	if (!accepted) {
		recordOptOut(root);
		return optedOut;
	}

	const init = await runSafely(request.run, "bd", ["init", "--non-interactive", "--init-if-missing"], root);
	if (init.code !== 0) {
		return { kind: "markdown", reason: `bd init failed at ${root}: ${failureText(init)}` };
	}
	return { kind: "beads", root };
}

function optOutPath(): string {
	return join(getAgentDir(), "beads-opt-out.json");
}

/** Git roots that declined Beads. A missing or malformed file means no opt-outs. */
function readOptOuts(): string[] {
	let text: string;
	try {
		text = readFileSync(optOutPath(), "utf8");
	} catch {
		return [];
	}
	try {
		const data: unknown = JSON.parse(text);
		if (typeof data === "object" && data !== null && "repos" in data && Array.isArray(data.repos)) {
			return data.repos.filter((repo): repo is string => typeof repo === "string");
		}
	} catch {
		// Malformed: treated as no opt-outs. The next recorded opt-out rewrites the file.
	}
	return [];
}

function recordOptOut(root: string): void {
	const path = optOutPath();
	const repos = readOptOuts();
	if (repos.includes(root)) return;
	const file: OptOutFile = { repos: [...repos, root] };
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
	renameSync(temp, path);
}

async function runSafely(run: CwdCommandRunner, command: string, args: string[], cwd: string): Promise<CommandOutput> {
	try {
		return await run(command, args, cwd);
	} catch (error) {
		return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
	}
}
