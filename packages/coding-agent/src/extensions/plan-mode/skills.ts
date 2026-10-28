import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { getPlanModeSkillsDir } from "../../config.ts";

/** Reads the private Plan Mode skill copies, including their Markdown references. */
export function readPlanModeSkills(names: readonly string[]): string {
	const root = getPlanModeSkillsDir();
	return names
		.map((name) => {
			const directory = join(root, name);
			const files = markdownFiles(directory).sort((left, right) => {
				if (basename(left) === "SKILL.md") return -1;
				if (basename(right) === "SKILL.md") return 1;
				return left.localeCompare(right);
			});
			if (files.length === 0) throw new Error(`Plan Mode skill "${name}" is missing from ${directory}.`);
			return files
				.map((file) => `### ${name}: ${relative(directory, file)}\n\n${readFileSync(file, "utf8").trim()}`)
				.join("\n\n");
		})
		.join("\n\n");
}

function markdownFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return markdownFiles(path);
		return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
	});
}
