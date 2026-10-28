import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// BDD contract for battlestar-pi-oev.8: the release renders the Homebrew formula for AvogadroSG1/homebrew-battlestar.

const script = fileURLToPath(new URL("./battlestar-homebrew-formula.mjs", import.meta.url));
const ARM_SHA = "a".repeat(64);
const INTEL_SHA = "b".repeat(64);

async function render(t, { version = "1.4.0-bs.2", checksums } = {}) {
	const root = await mkdtemp(join(tmpdir(), "battlestar-formula-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const checksumsPath = join(root, "checksums.txt");
	await writeFile(
		checksumsPath,
		checksums ?? `${ARM_SHA}  battlestar-darwin-arm64.tar.gz\n${INTEL_SHA}  battlestar-darwin-x64.tar.gz\n`,
	);
	return spawnSync(process.execPath, [script, version, checksumsPath], { encoding: "utf8" });
}

test("renders a formula that downloads the release binary for the machine's architecture", async (t) => {
	const result = await render(t);

	assert.equal(result.status, 0, result.stderr);
	const formula = result.stdout;
	assert.match(formula, /^class Battlestar < Formula$/m);
	assert.match(formula, /^\s*version "1\.4\.0-bs\.2"$/m);
	const base = "https://github.com/AvogadroSG1/battlestar-pi/releases/download/v1.4.0-bs.2";
	assert.ok(formula.includes(`url "${base}/battlestar-darwin-arm64.tar.gz"`), formula);
	assert.ok(formula.includes(`url "${base}/battlestar-darwin-x64.tar.gz"`), formula);
	assert.ok(formula.includes(`sha256 "${ARM_SHA}"`), formula);
	assert.ok(formula.includes(`sha256 "${INTEL_SHA}"`), formula);
	assert.ok(formula.indexOf(ARM_SHA) > formula.indexOf("on_arm"), "arm checksum belongs to the arm block");
	assert.ok(formula.indexOf(INTEL_SHA) > formula.indexOf("on_intel"), "intel checksum belongs to the intel block");
});

test("declares Beads as a dependency and installs the battlestar command", async (t) => {
	const formula = (await render(t)).stdout;

	assert.match(formula, /^\s*depends_on "beads"$/m);
	assert.match(formula, /^\s*depends_on :macos$/m);
	assert.match(formula, /bin\.install|bin\.write_exec_script|\(bin\/"battlestar"\)/);
	assert.match(formula, /^\s*test do$/m);
	assert.ok(formula.includes('"#{bin}/battlestar", "--version"'), formula);
});

test("fails without publishing a formula when a macOS archive checksum is missing", async (t) => {
	const result = await render(t, { checksums: `${ARM_SHA}  battlestar-darwin-arm64.tar.gz\n` });

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.ok(result.stderr.includes("battlestar-darwin-x64.tar.gz"), result.stderr);
});
