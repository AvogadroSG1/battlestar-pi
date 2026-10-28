/**
 * Core skills are plan mode's private resources (ADR 0002). This module renders the pinned copy in
 * core-skills/ into plan mode's context. It never reads registered skills or user skill directories,
 * so a user's own install of the same skill does not change plan-mode behavior.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCoreSkillsDir } from "../../config.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";

export type CoreSkillName =
	| "grill-with-docs"
	| "grilling"
	| "domain-modeling"
	| "to-tickets"
	| "handoff"
	| "tdd"
	| "code-review"
	| "diagnosing-bugs"
	| "codebase-design"
	| "beads";

/**
 * Renders each named skill as a `<skill>` block, the same shape an expanded `/skill:` command uses.
 * The body is the SKILL.md text with its frontmatter removed, verbatim.
 */
export function renderCoreSkills(names: readonly CoreSkillName[]): string {
	return names
		.map((name) => {
			const dir = join(getCoreSkillsDir(), name);
			const filePath = join(dir, "SKILL.md");
			const body = stripFrontmatter(readFileSync(filePath, "utf-8")).trim();
			return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${dir}.\n\n${body}\n</skill>`;
		})
		.join("\n\n");
}
