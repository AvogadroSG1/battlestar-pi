import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./battlestar-release-version.mjs", import.meta.url));

/** Runs the release-tag check against a coding-agent package.json with the given base version and revision. */
async function checkTag(t, tag, { version = "1.4.0", harnessRevision = 1 } = {}) {
	const root = await mkdtemp(join(tmpdir(), "battlestar-release-version-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const packageJson = join(root, "package.json");
	await writeFile(
		packageJson,
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, piConfig: { name: "battlestar", harnessRevision } }),
	);
	return spawnSync(process.execPath, [script, tag, "--package", packageJson], { encoding: "utf8" });
}

test("accepts a release tag that names the harness version and prints that version", async (t) => {
	const result = await checkTag(t, "v1.4.0-bs.3", { harnessRevision: 3 });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "1.4.0-bs.3");
});

test("fails when the tag's bs counter differs from the package's harness revision", async (t) => {
	const result = await checkTag(t, "v1.4.0-bs.2", { harnessRevision: 3 });

	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("v1.4.0-bs.2"), result.stderr);
	assert.ok(result.stderr.includes("1.4.0-bs.3"), result.stderr);
});

test("fails when the tag's upstream base differs from the package version", async (t) => {
	const result = await checkTag(t, "v1.5.0-bs.1", { version: "1.4.0", harnessRevision: 1 });

	assert.equal(result.status, 1);
	assert.ok(result.stderr.includes("1.4.0-bs.1"), result.stderr);
});

test("fails for tags that are not shaped like v<base>-bs.<N>", async (t) => {
	for (const tag of ["1.4.0-bs.1", "v1.4.0", "v1.4.0-beta.1"]) {
		const result = await checkTag(t, tag);
		assert.equal(result.status, 1, `${tag} should be rejected`);
	}
});
