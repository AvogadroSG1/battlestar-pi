# Battlestar runs as its own command with its own configuration

battlestar-pi is installed as the `battlestar` command, reading `~/.battlestar/agent` and project `.battlestar/` only, rather than masquerading as `pi` and sharing `~/.pi`. A fork that shares stock pi's files would have two different programs writing the same settings, sessions, and extensions, and every repo's `.pi/` content would silently change the harness. On first run the harness copies `auth.json` and `settings.json` from `~/.pi/agent` once; sessions and extensions are not carried over, and herdr's integration is reinstalled against the new directory on first run. git-ai is not carried over: its pi hook path is fixed to `~/.pi/agent`, so the harness records no AI authorship until git-ai supports a config-dir override.

## Consequences

- Upstream merges conflict wherever pi's identity (`bin`, `piConfig.configDir`) or self-update path is touched.
- Stock-pi project config in `.pi/` is ignored by the harness; skills in `.agents/skills/` are unaffected.
