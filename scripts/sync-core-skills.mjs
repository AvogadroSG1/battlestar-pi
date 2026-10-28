#!/usr/bin/env node
/**
 * Refreshes plan mode's pinned copy of the core skills (ADR 0002) from apm's `.agents/skills/`.
 *
 * Usage: node scripts/sync-core-skills.mjs [--source <dir>] [--dest <dir>]
 *
 * All ten core skills must exist in the source first; otherwise the missing names go to stderr and
 * nothing changes. The destination is then replaced so it holds exactly the ten skill directories,
 * byte-identical to the source. Stale files and non-core directories are removed.
 */

import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CORE_SKILLS = [
	"grill-with-docs",
	"grilling",
	"domain-modeling",
	"to-tickets",
	"handoff",
	"tdd",
	"code-review",
	"diagnosing-bugs",
	"codebase-design",
	"beads",
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
	options: {
		source: { type: "string" },
		dest: { type: "string" },
	},
	strict: true,
});
const source = resolve(values.source ?? join(repoRoot, ".agents", "skills"));
const dest = resolve(values.dest ?? join(repoRoot, "packages", "coding-agent", "core-skills"));

async function hasSkillFile(name) {
	try {
		return (await stat(join(source, name, "SKILL.md"))).isFile();
	} catch {
		return false;
	}
}

const missing = [];
for (const name of CORE_SKILLS) {
	if (!(await hasSkillFile(name))) missing.push(name);
}
if (missing.length > 0) {
	process.stderr.write(`sync-core-skills: missing from ${source}: ${missing.join(", ")}\n`);
	process.exit(1);
}

// Copy into a sibling staging directory first, so a failed copy leaves the pinned copy untouched.
const staging = `${dest}.staging`;
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const name of CORE_SKILLS) {
	await cp(join(source, name), join(staging, name), { recursive: true });
}
await mkdir(dirname(dest), { recursive: true });
await rm(dest, { recursive: true, force: true });
await rename(staging, dest);

process.stdout.write(`sync-core-skills: pinned ${CORE_SKILLS.length} core skills from ${source} to ${dest}\n`);
