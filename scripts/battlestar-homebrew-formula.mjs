#!/usr/bin/env node
// Renders the Homebrew formula for the AvogadroSG1/homebrew-battlestar tap from a battlestar
// release's checksums.txt. The formula downloads the release archive for the machine's
// architecture, installs the whole archive directory into libexec, and writes a bin/battlestar
// launcher. Inside herdr the launcher sets argv0 to `pi` so herdr recognizes the harness.
//
// Usage: node scripts/battlestar-homebrew-formula.mjs <version> <checksums.txt>
// Prints the formula to stdout; exits 1 with a message on stderr otherwise.

import { readFileSync } from "node:fs";

const VERSION_RE = /^\d+\.\d+\.\d+-bs\.\d+$/;
const CHECKSUM_LINE_RE = /^([0-9a-f]{64})\s+\*?(\S+)$/;
const REPO_URL = "https://github.com/AvogadroSG1/battlestar-pi";
const ARM_ARCHIVE = "battlestar-darwin-arm64.tar.gz";
const INTEL_ARCHIVE = "battlestar-darwin-x64.tar.gz";

function usage() {
	return "Usage: node scripts/battlestar-homebrew-formula.mjs <version> <checksums.txt>";
}

function parseArgs(argv) {
	if (argv.length !== 2) throw new Error(usage());
	const [version, checksumsPath] = argv;
	if (!VERSION_RE.test(version)) {
		throw new Error(`Version ${version} is not a battlestar harness version; expected <base>-bs.<N>.`);
	}
	return { version, checksumsPath };
}

/** Maps archive file name to sha256 from `shasum -a 256` output lines. */
function readChecksums(checksumsPath) {
	const checksums = new Map();
	for (const line of readFileSync(checksumsPath, "utf8").split("\n")) {
		const match = CHECKSUM_LINE_RE.exec(line.trim());
		if (match) checksums.set(match[2], match[1]);
	}
	return checksums;
}

function requireChecksum(checksums, archive) {
	const sha256 = checksums.get(archive);
	if (sha256 === undefined) {
		throw new Error(`checksums.txt has no sha256 line for ${archive}; the formula needs both macOS archives.`);
	}
	return sha256;
}

function render(version, checksums) {
	const downloadBase = `${REPO_URL}/releases/download/v${version}`;
	const armSha = requireChecksum(checksums, ARM_ARCHIVE);
	const intelSha = requireChecksum(checksums, INTEL_ARCHIVE);
	return `class Battlestar < Formula
  desc "Opinionated coding-agent harness with a built-in planning workflow"
  homepage "${REPO_URL}"
  version "${version}"
  license "MIT"

  depends_on "beads"
  depends_on :macos

  on_macos do
    on_arm do
      url "${downloadBase}/${ARM_ARCHIVE}"
      sha256 "${armSha}"
    end
    on_intel do
      url "${downloadBase}/${INTEL_ARCHIVE}"
      sha256 "${intelSha}"
    end
  end

  def install
    libexec.install Dir["*"]
    bin.mkpath
    (bin/"battlestar").write <<~EOS
      #!/bin/bash
      if [[ "$HERDR_ENV" == "1" ]]; then
        exec -a pi "#{libexec}/battlestar" "$@"
      fi
      exec "#{libexec}/battlestar" "$@"
    EOS
    (bin/"battlestar").chmod 0755
  end

  test do
    args = ["#{bin}/battlestar", "--version"]
    system(*args)
    assert_match version.to_s, shell_output(args.join(" "))
  end
end
`;
}

function main(argv) {
	const { version, checksumsPath } = parseArgs(argv);
	return render(version, readChecksums(checksumsPath));
}

try {
	process.stdout.write(main(process.argv.slice(2)));
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
