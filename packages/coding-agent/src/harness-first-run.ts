import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";
import { spawnProcessSync } from "./utils/child-process.ts";

/** The only stock pi files the harness copies. Sessions and extensions are never carried over (ADR 0001). */
const CARRIED_OVER_FILES = ["auth.json", "settings.json"] as const;

/**
 * First-run setup for the harness global config (ADR 0001).
 *
 * When the harness agent dir does not exist, create it, copy `auth.json` and `settings.json` once from
 * stock pi's `~/.pi/agent`, and install herdr's pi integration into the harness's global extensions. If the
 * harness agent dir already exists, do nothing.
 *
 * @returns true when this call performed the first run, false when the harness agent dir already existed.
 */
export function runHarnessFirstRun(): boolean {
	const harnessDir = getAgentDir();
	if (existsSync(harnessDir)) return false;

	mkdirSync(harnessDir, { recursive: true });
	const stockDir = join(homedir(), ".pi", "agent");
	for (const name of CARRIED_OVER_FILES) {
		const source = join(stockDir, name);
		if (!existsSync(source)) continue;
		const target = join(harnessDir, name);
		copyFileSync(source, target);
		if (name === "auth.json") chmodSync(target, 0o600);
	}
	registerHerdrIntegration(harnessDir);
	return true;
}

/** herdr's command that writes its pi integration (`herdr-agent-state.ts`) into `$PI_CODING_AGENT_DIR/extensions`. */
const HERDR_INSTALL_ARGS = ["integration", "install", "pi"] as const;
const HERDR_INSTALL_TIMEOUT_MS = 15_000;

/**
 * Install herdr's pi integration against the harness agent dir. A missing herdr is skipped silently. Any other
 * failure (non-zero exit, timeout, spawn error) prints one warning with the manual command and returns, so
 * startup always continues. git-ai is not registered: its pi hook path is fixed to `~/.pi/agent` (ADR 0001).
 */
function registerHerdrIntegration(harnessDir: string): void {
	const result = spawnProcessSync("herdr", [...HERDR_INSTALL_ARGS], {
		env: { ...process.env, PI_CODING_AGENT_DIR: harnessDir },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: HERDR_INSTALL_TIMEOUT_MS,
	});
	if (result.status === 0) return;
	if (result.error && "code" in result.error && result.error.code === "ENOENT") return;
	const manual = `PI_CODING_AGENT_DIR=${harnessDir} herdr ${HERDR_INSTALL_ARGS.join(" ")}`;
	process.stderr.write(`Warning: could not install herdr's pi integration. Run manually: ${manual}\n`);
}
