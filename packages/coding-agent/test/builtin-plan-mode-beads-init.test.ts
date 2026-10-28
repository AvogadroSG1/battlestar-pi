import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { fakeBd } from "./builtin-plan-mode-fake-bd.ts";
import { type ExecResultLike, type PlanHarness, setupPlanMode } from "./builtin-plan-mode-harness.ts";

// BDD contract for battlestar-pi-oev.5: plan mode initializes Beads at publish on consent, records a Beads opt-out
// against the resolved git root on refusal, and otherwise falls back to the Markdown tracker.

const BEADS_PROMPT = /beads/i;
const NO_WORKSPACE = "Error: No active beads workspace found.";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

beforeEach(() => {
	// The Beads opt-out is recorded in the harness's global config.
	vi.stubEnv(ENV_AGENT_DIR, tmp("plan-beads-agent-"));
});

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(): string {
	const root = realpathSync(tmp("plan-beads-repo-"));
	spawnSync("git", ["init", "-q"], { cwd: root });
	mkdirSync(join(root, "app"), { recursive: true });
	return root;
}

function gitRoot(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	return result.status === 0 ? realpathSync(result.stdout.trim()) : undefined;
}

/**
 * The machine around plan mode: real git, and a `bd` that is either missing from PATH (spawn fails the way
 * pi.exec reports it) or installed, with a Beads database per git root once `bd init` ran there.
 */
function machine(options: { bdInstalled?: boolean; initializedRoots?: string[] } = {}) {
	const tracker = fakeBd();
	const initializedRoots = new Set(options.initializedRoots ?? []);
	const inits: { cwd: string | undefined; args: string[] }[] = [];
	const exec = async (command: string, args: string[], execOptions?: { cwd?: string }): Promise<ExecResultLike> => {
		if (command === "git") {
			const result = spawnSync("git", args, { cwd: execOptions?.cwd, encoding: "utf8" });
			return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
		}
		if (command !== "bd") return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		if (options.bdInstalled === false) return { stdout: "", stderr: "spawn bd ENOENT", code: 1 };
		if (args[0] === "--version" || args[0] === "version") return { stdout: "bd version 1.3.2", stderr: "", code: 0 };
		const root = gitRoot(execOptions?.cwd);
		if (args[0] === "init") {
			inits.push({ cwd: execOptions?.cwd, args });
			if (root) initializedRoots.add(root);
			return { stdout: "", stderr: "", code: 0 };
		}
		const initialized = root !== undefined && initializedRoots.has(root);
		if (args[0] === "where") {
			return initialized
				? { stdout: join(root, ".beads"), stderr: "", code: 0 }
				: { stdout: "", stderr: NO_WORKSPACE, code: 1 };
		}
		if (!initialized) return { stdout: "", stderr: NO_WORKSPACE, code: 1 };
		return tracker.exec(command, args);
	};
	return { exec, inits, initializedRoots, tracker };
}

/** Plans one ticket from `cwd` up to publishing, answering the Beads prompt with `acceptBeads`. */
async function publishFrom(
	cwd: string,
	exec: ReturnType<typeof machine>["exec"],
	acceptBeads = false,
): Promise<{ h: PlanHarness; tracker: unknown; beadsPrompts: number }> {
	let beadsPrompts = 0;
	const h = setupPlanMode({
		cwd,
		exec,
		confirm: (title, message) => {
			if (BEADS_PROMPT.test(`${title} ${message}`)) {
				beadsPrompts++;
				return acceptBeads;
			}
			return true;
		},
	});
	await h.runCommand("plan", "build the thing");
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
	const published = await h.runTool("plan_tickets", { action: "publish" });
	return { h, tracker: published.details?.tracker, beadsPrompts };
}

describe("Beads at publish", () => {
	it("initializes Beads at the git root when the user accepts, and publishes the tickets there", async () => {
		const root = gitRepo();
		const world = machine();

		const result = await publishFrom(join(root, "app"), world.exec, true);

		expect(result.beadsPrompts).toBe(1);
		expect(world.inits).toEqual([{ cwd: root, args: ["init", "--non-interactive", "--init-if-missing"] }]);
		expect(result.tracker).toBe("beads");
		expect(world.tracker.issues.size).toBeGreaterThan(0);
	});

	it("records the opt-out against the git root when the user declines, and never asks again in that repo", async () => {
		const root = gitRepo();
		const world = machine();

		const first = await publishFrom(join(root, "app"), world.exec, false);
		expect(first.beadsPrompts).toBe(1);
		expect(first.tracker).toBe("markdown");
		expect(world.inits).toEqual([]);

		const second = await publishFrom(root, world.exec, true);
		expect(second.beadsPrompts).toBe(0);
		expect(second.tracker).toBe("markdown");
		expect(world.inits).toEqual([]);
	});

	it("uses Beads after an opt-out once the user ran bd init themselves", async () => {
		const root = gitRepo();
		const world = machine();
		await publishFrom(root, world.exec, false);

		world.initializedRoots.add(root);
		const result = await publishFrom(root, world.exec, false);

		expect(result.beadsPrompts).toBe(0);
		expect(result.tracker).toBe("beads");
	});

	it("uses an existing Beads database without asking", async () => {
		const root = gitRepo();
		const world = machine({ initializedRoots: [root] });

		const result = await publishFrom(join(root, "app"), world.exec, false);

		expect(result.beadsPrompts).toBe(0);
		expect(result.tracker).toBe("beads");
		expect(world.inits).toEqual([]);
	});

	it("uses the Markdown tracker without asking outside a git repo", async () => {
		const world = machine();

		const result = await publishFrom(tmp("plan-beads-no-git-"), world.exec, true);

		expect(result.beadsPrompts).toBe(0);
		expect(result.tracker).toBe("markdown");
		expect(world.inits).toEqual([]);
	});

	it("uses the Markdown tracker and names the install command when bd is not on PATH", async () => {
		const root = gitRepo();
		const world = machine({ bdInstalled: false });

		const result = await publishFrom(root, world.exec, true);

		expect(result.beadsPrompts).toBe(0);
		expect(result.tracker).toBe("markdown");
		const notices = result.h.notify.mock.calls.map((call) => String(call[0])).join("\n");
		expect(notices).toContain("brew install beads");
	});
});
