import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
// Directories with the basic system tools but without a real herdr installation.
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for the herdr CLI. `herdr integration install pi` writes herdr's pi integration into
 * `$PI_CODING_AGENT_DIR/extensions` (as the real herdr does) and logs each call.
 */
const FAKE_HERDR = `#!/bin/sh
printf '%s|%s\\n' "$*" "$PI_CODING_AGENT_DIR" >> "$FAKE_HERDR_LOG"
if [ "$FAKE_HERDR_FAIL" = "1" ]; then
  echo "herdr: integration install failed" >&2
  exit 1
fi
if [ "$1 $2 $3" = "integration install pi" ]; then
  mkdir -p "$PI_CODING_AGENT_DIR/extensions"
  printf '// installed by herdr\\nexport default function () {}\\n' > "$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts"
fi
exit 0
`;

interface Fixture {
	home: string;
	cwd: string;
	harnessDir: string;
	piAgentDir: string;
	binDir: string;
	herdrLog: string;
}

function setup(options: { withHerdr: boolean }): Fixture {
	const root = mkdtempSync(join(tmpdir(), "battlestar-herdr-"));
	tempDirs.push(root);
	const fixture: Fixture = {
		home: join(root, "home"),
		cwd: join(root, "project"),
		harnessDir: join(root, "home", ".battlestar", "agent"),
		piAgentDir: join(root, "home", ".pi", "agent"),
		binDir: join(root, "bin"),
		herdrLog: join(root, "herdr.log"),
	};
	mkdirSync(fixture.home, { recursive: true });
	mkdirSync(fixture.cwd, { recursive: true });
	mkdirSync(fixture.binDir, { recursive: true });
	if (options.withHerdr) {
		const herdr = join(fixture.binDir, "herdr");
		writeFileSync(herdr, FAKE_HERDR);
		chmodSync(herdr, 0o755);
	}
	return fixture;
}

function herdrCalls(fixture: Fixture): string[] {
	if (!existsSync(fixture.herdrLog)) return [];
	return readFileSync(fixture.herdrLog, "utf8").trim().split("\n").filter(Boolean);
}

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function startHarness(fixture: Fixture, env: Record<string, string> = {}): Promise<CliResult> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.BATTLESTAR_CODING_AGENT_DIR;
	Object.assign(
		childEnv,
		{
			HOME: fixture.home,
			USERPROFILE: fixture.home,
			PATH: `${fixture.binDir}:${dirname(process.execPath)}:${SYSTEM_PATH}`,
			PI_OFFLINE: "1",
			FAKE_HERDR_LOG: fixture.herdrLog,
		},
		env,
	);
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "--list-models"], {
		cwd: fixture.cwd,
		env: childEnv,
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

describe("herdr registration on the harness's first run", () => {
	it("installs herdr's pi integration into the harness's global extensions once", async () => {
		const fixture = setup({ withHerdr: true });

		const first = await startHarness(fixture);
		expect(first.code, first.stderr).toBe(0);
		expect(existsSync(join(fixture.harnessDir, "extensions", "herdr-agent-state.ts"))).toBe(true);
		expect(herdrCalls(fixture)).toEqual([`integration install pi|${fixture.harnessDir}`]);

		const second = await startHarness(fixture);
		expect(second.code, second.stderr).toBe(0);
		expect(herdrCalls(fixture)).toHaveLength(1);
	});

	it("neither copies nor loads git-ai's extension from stock pi", async () => {
		const fixture = setup({ withHerdr: true });
		const marker = join(fixture.home, "git-ai-loaded");
		mkdirSync(join(fixture.piAgentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(fixture.piAgentDir, "extensions", "git-ai.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default function () {}\n`,
		);

		const result = await startHarness(fixture);

		expect(result.code, result.stderr).toBe(0);
		expect(existsSync(join(fixture.harnessDir, "extensions", "git-ai.ts"))).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});

	it("registers nothing and warns about nothing when herdr is not installed", async () => {
		const fixture = setup({ withHerdr: false });

		const result = await startHarness(fixture);

		expect(result.code, result.stderr).toBe(0);
		expect(existsSync(join(fixture.harnessDir, "extensions", "herdr-agent-state.ts"))).toBe(false);
		expect(result.stderr.toLowerCase()).not.toContain("herdr");
	});

	it("warns with the manual command and keeps starting when herdr's install fails", async () => {
		const fixture = setup({ withHerdr: true });

		const result = await startHarness(fixture, { FAKE_HERDR_FAIL: "1" });

		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain(`PI_CODING_AGENT_DIR=${fixture.harnessDir} herdr integration install pi`);
		expect(existsSync(join(fixture.harnessDir, "extensions", "herdr-agent-state.ts"))).toBe(false);
	});
});
