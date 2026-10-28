import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./sync-core-skills.mjs", import.meta.url));

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

async function writeTree(root, files) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), content);
	}
}

async function readTree(root) {
	const files = {};
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else files[relative(root, path)] = await readFile(path, "utf8");
		}
	}
	await walk(root);
	return files;
}

/** An apm `.agents/skills/` with all ten core skills, one non-core skill, and nested reference files. */
function apmSkills() {
	const files = { "wizard/SKILL.md": "---\nname: wizard\n---\nnot a core skill\n" };
	for (const name of CORE_SKILLS) {
		files[`${name}/SKILL.md`] = `---\nname: ${name}\ndescription: ${name} from apm\n---\n\n${name} body v2\n`;
		files[`${name}/agents/openai.yaml`] = `name: ${name}\n`;
	}
	files["tdd/tests.md"] = "tdd reference v2\n";
	return files;
}

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "sync-core-skills-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { source: join(root, "agents-skills"), dest: join(root, "core-skills") };
}

function sync(source, dest) {
	return spawnSync(process.execPath, [script, "--source", source, "--dest", dest], { encoding: "utf8" });
}

test("refreshes the pinned copy to exactly the ten core skills from apm's .agents/skills", async (t) => {
	const { source, dest } = await fixture(t);
	await writeTree(source, apmSkills());
	await writeTree(dest, {
		"tdd/SKILL.md": "stale tdd\n",
		"tdd/old-reference.md": "removed upstream\n",
		"retired-skill/SKILL.md": "no longer a core skill\n",
	});

	const result = sync(source, dest);

	assert.equal(result.status, 0, result.stderr);
	const expected = Object.fromEntries(
		Object.entries(apmSkills()).filter(([path]) => CORE_SKILLS.includes(path.split("/")[0])),
	);
	assert.deepEqual(await readTree(dest), expected);
});

test("changes nothing and fails when a core skill is missing from apm's .agents/skills", async (t) => {
	const { source, dest } = await fixture(t);
	const files = apmSkills();
	for (const path of Object.keys(files)) if (path.startsWith("beads/")) delete files[path];
	await writeTree(source, files);
	await writeTree(dest, { "tdd/SKILL.md": "pinned tdd\n" });

	const result = sync(source, dest);

	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("beads"), result.stderr);
	assert.deepEqual(await readTree(dest), { "tdd/SKILL.md": "pinned tdd\n" });
});
