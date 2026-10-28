import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { checkForNewPiVersion } from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	process.exitCode = undefined;
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "battlestar-identity-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** models.json declaring one probe model, so `--list-models` shows which global config was read. */
function probeModels(provider: string, modelId: string) {
	return {
		providers: {
			[provider]: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				apiKey: "probe-key",
				models: [{ id: modelId }],
			},
		},
	};
}

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Runs the harness CLI with a fake home directory and no inherited agent-dir overrides. */
async function runCli(args: string[], options: { home: string; cwd: string; env?: Record<string, string> }) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PI_CODING_AGENT_DIR;
	delete env.BATTLESTAR_CODING_AGENT_DIR;
	Object.assign(env, { HOME: options.home, USERPROFILE: options.home, PI_OFFLINE: "1" }, options.env);
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
		cwd: options.cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise<CliResult>((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stdout, stderr });
		});
	});
}

function setupHome() {
	const root = createTempDir();
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, home, cwd, piAgentDir: join(home, ".pi", "agent"), harnessDir: join(home, ".battlestar", "agent") };
}

describe("battlestar harness identity", () => {
	it("copies auth and settings from stock pi once on first start, and never sessions or extensions", async () => {
		const { home, cwd, piAgentDir, harnessDir } = setupHome();
		writeJson(join(piAgentDir, "auth.json"), { probe: { type: "api_key", key: "from-pi" } });
		writeJson(join(piAgentDir, "settings.json"), { defaultThinkingLevel: "high" });
		mkdirSync(join(piAgentDir, "sessions", "--project--"), { recursive: true });
		writeFileSync(join(piAgentDir, "sessions", "--project--", "old.jsonl"), "");
		mkdirSync(join(piAgentDir, "extensions"), { recursive: true });
		writeFileSync(join(piAgentDir, "extensions", "stock.ts"), "export default function () {}\n");

		const first = await runCli(["--list-models"], { home, cwd });
		expect(first.code, first.stderr).toBe(0);

		expect(readJson(join(harnessDir, "auth.json"))).toEqual({ probe: { type: "api_key", key: "from-pi" } });
		expect(readJson(join(harnessDir, "settings.json")).defaultThinkingLevel).toBe("high");
		expect(existsSync(join(harnessDir, "sessions", "--project--", "old.jsonl"))).toBe(false);
		expect(existsSync(join(harnessDir, "extensions", "stock.ts"))).toBe(false);

		// Later starts copy nothing, even when stock pi's files change.
		writeJson(join(piAgentDir, "auth.json"), { probe: { type: "api_key", key: "changed-in-pi" } });
		writeJson(join(piAgentDir, "settings.json"), { defaultThinkingLevel: "low" });
		const second = await runCli(["--list-models"], { home, cwd });
		expect(second.code, second.stderr).toBe(0);

		expect(readJson(join(harnessDir, "auth.json"))).toEqual({ probe: { type: "api_key", key: "from-pi" } });
		expect(readJson(join(harnessDir, "settings.json")).defaultThinkingLevel).toBe("high");
	});

	it("uses BATTLESTAR_CODING_AGENT_DIR as the global config", async () => {
		const { root, home, cwd } = setupHome();
		const battlestarDir = join(root, "battlestar-agent");
		const piDir = join(root, "pi-agent");
		writeJson(join(battlestarDir, "models.json"), probeModels("bs-probe", "bs-probe-model"));
		writeJson(join(piDir, "models.json"), probeModels("pi-probe", "pi-probe-model"));

		const result = await runCli(["--list-models"], {
			home,
			cwd,
			env: { BATTLESTAR_CODING_AGENT_DIR: battlestarDir, PI_CODING_AGENT_DIR: piDir },
		});

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("bs-probe-model");
		expect(result.stdout).not.toContain("pi-probe-model");
	});

	it("prints a version shaped like <upstream base>-bs.<N>", async () => {
		const { home, cwd } = setupHome();

		const result = await runCli(["--version"], { home, cwd });

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+-bs\.\d+$/);
	});

	it("ignores stock pi's project config in .pi/", async () => {
		const { root, cwd } = setupHome();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "stock-project.ts"), "export default function () {}\n");
		writeJson(join(cwd, ".pi", "settings.json"), { defaultThinkingLevel: "minimal" });

		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(settingsManager.getProjectSettings()).toEqual({});

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload({ resolveProjectTrust: async () => true });
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([]);
	});

	it("points `update self` at Homebrew without contacting upstream", async () => {
		allowNetwork();
		vi.stubEnv("BATTLESTAR_CODING_AGENT_DIR", createTempDir());
		const fetchMock = vi.fn(async () => Response.json({ version: "99.0.0" }));
		vi.stubGlobal("fetch", fetchMock);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void output.push(args.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void output.push(args.join(" ")));

		try {
			expect(await handlePackageCommand(["update", "self"])).toBe(true);
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}

		expect(output.join("\n")).toContain("brew upgrade battlestar");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("reports no update notice when upstream publishes a newer pi", async () => {
		allowNetwork();
		vi.stubEnv("PI_SKIP_VERSION_CHECK", undefined);
		const fetchMock = vi.fn(async () => Response.json({ version: "99.0.0" }));
		vi.stubGlobal("fetch", fetchMock);

		try {
			await expect(checkForNewPiVersion(VERSION)).resolves.toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
