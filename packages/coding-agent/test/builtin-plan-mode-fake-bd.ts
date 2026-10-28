import type { ExecResultLike } from "./builtin-plan-mode-harness.ts";

/**
 * In-memory fake of the `bd` CLI used by the plan-mode tests.
 *
 * Supports: `create` (records title/type/parent/description/skills, prints the new id),
 * `dep add <issue> --blocked-by <blocker>` (or positional), `create --deps`, `close <id>`,
 * and `list --parent <epic> --json` (real bd shape: dependencies[{depends_on_id, type}]).
 * Every other subcommand succeeds with `[]`. With `usable: false` every subcommand fails like an
 * uninitialised database (`--version` still succeeds). `git rev-parse --show-toplevel` answers with
 * the cwd, so every test directory is a git root and the tracker choice reaches Beads.
 */
export interface FakeIssue {
	title: string;
	type?: string;
	parent?: string;
	description?: string;
	skills?: string;
	status: string;
}

export interface FakeBdOptions {
	usable?: boolean;
	failOnCreateNumber?: number;
}

export function fakeBd(options: FakeBdOptions = {}) {
	const issues = new Map<string, FakeIssue>();
	const edges: [string, string][] = []; // [issue, blockedBy]
	const order: string[] = [];
	const calls: string[][] = [];
	let n = 0;
	let creates = 0;

	function flag(args: string[], ...names: string[]): string | undefined {
		const i = args.findIndex((a) => names.includes(a));
		return i >= 0 ? args[i + 1] : undefined;
	}

	const exec = async (command: string, args: string[], execOptions?: { cwd?: string }): Promise<ExecResultLike> => {
		if (command === "git") {
			return args.join(" ") === "rev-parse --show-toplevel" && execOptions?.cwd
				? { stdout: `${execOptions.cwd}\n`, stderr: "", code: 0 }
				: { stdout: "", stderr: "unexpected git command", code: 1 };
		}
		calls.push([command, ...args]);
		if (command !== "bd") return { stdout: "", stderr: "bd: not initialized", code: 1 };
		if (args[0] === "--version") return { stdout: "bd version 1.3.2", stderr: "", code: 0 };
		if (options.usable === false) return { stdout: "", stderr: "bd: not initialized", code: 1 };
		const [sub, second] = args;
		if (sub === "create") {
			creates += 1;
			if (options.failOnCreateNumber === creates) return { stdout: "", stderr: "boom", code: 1 };
			const id = `t-${++n}`;
			issues.set(id, {
				title: args[1] ?? flag(args, "--title") ?? "",
				type: flag(args, "-t", "--type"),
				parent: flag(args, "--parent"),
				description: flag(args, "-d", "--description"),
				skills: flag(args, "--skills"),
				status: "open",
			});
			order.push(id);
			for (const dep of (flag(args, "--deps") ?? "").split(",").filter(Boolean))
				edges.push([id, dep.replace(/^[a-z-]+:/, "")]);
			return { stdout: `${id}\n`, stderr: "", code: 0 };
		}
		if (sub === "dep" && second === "add") {
			const blocker = flag(args, "--blocked-by", "--depends-on") ?? args[3];
			edges.push([args[2]!, blocker!]);
			return { stdout: "", stderr: "", code: 0 };
		}
		if (sub === "close") {
			const issue = issues.get(second ?? "");
			if (!issue) return { stdout: "", stderr: "no such issue", code: 1 };
			issue.status = "closed";
			return { stdout: "", stderr: "", code: 0 };
		}
		if (sub === "list" && args.includes("--json")) {
			const parent = flag(args, "--parent");
			const rows = [...issues.entries()]
				.filter(([, issue]) => issue.parent === parent)
				.map(([id, issue]) => ({
					id,
					title: issue.title,
					status: issue.status,
					parent: issue.parent,
					dependencies: [
						{ issue_id: id, depends_on_id: parent, type: "parent-child" },
						...edges
							.filter(([from]) => from === id)
							.map(([, blocker]) => ({ issue_id: id, depends_on_id: blocker, type: "blocks" })),
					],
				}));
			return { stdout: JSON.stringify(rows), stderr: "", code: 0 };
		}
		return { stdout: "[]", stderr: "", code: 0 };
	};

	return { exec, issues, edges, order, calls };
}
