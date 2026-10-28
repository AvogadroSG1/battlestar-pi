#!/usr/bin/env node
// Checks that a battlestar release tag (v<base>-bs.<N>) names the harness version
// in packages/coding-agent/package.json, which is `<version>-bs.<piConfig.harnessRevision>`.
//
// Usage: node scripts/battlestar-release-version.mjs <tag> [--package <path>]
// Prints the verified harness version on success; exits 1 with a message otherwise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PACKAGE = fileURLToPath(new URL("../packages/coding-agent/package.json", import.meta.url));
const TAG_RE = /^v(\d+\.\d+\.\d+)-bs\.(\d+)$/;

function usage() {
	return "Usage: node scripts/battlestar-release-version.mjs <tag> [--package <path to coding-agent package.json>]";
}

function parseArgs(argv) {
	let tag;
	let packagePath = DEFAULT_PACKAGE;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--package") {
			packagePath = argv[++i];
			if (packagePath === undefined) throw new Error(`--package requires a path.\n${usage()}`);
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown option ${arg}.\n${usage()}`);
		} else if (tag === undefined) {
			tag = arg;
		} else {
			throw new Error(`Unexpected argument ${arg}.\n${usage()}`);
		}
	}
	if (tag === undefined) throw new Error(usage());
	return { tag, packagePath };
}

function readHarnessVersion(packagePath) {
	const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
	const revision = manifest.piConfig?.harnessRevision;
	if (typeof manifest.version !== "string" || !Number.isInteger(revision) || revision < 0) {
		throw new Error(
			`${packagePath} needs a version and an integer piConfig.harnessRevision to name a harness release.`,
		);
	}
	return `${manifest.version}-bs.${revision}`;
}

function main(argv) {
	const { tag, packagePath } = parseArgs(argv);
	const match = TAG_RE.exec(tag);
	if (!match) {
		throw new Error(`Tag ${tag} is not a battlestar release tag; expected v<major>.<minor>.<patch>-bs.<N>.`);
	}
	const expected = readHarnessVersion(packagePath);
	const tagVersion = `${match[1]}-bs.${match[2]}`;
	if (tagVersion !== expected) {
		throw new Error(
			`Tag ${tag} does not match the package harness version. Expected tag v${expected} (${packagePath} names ${expected}).`,
		);
	}
	return expected;
}

try {
	process.stdout.write(`${main(process.argv.slice(2))}\n`);
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
