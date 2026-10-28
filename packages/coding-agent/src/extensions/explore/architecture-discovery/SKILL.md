---
name: architecture-discovery
description: Discover runtime architecture nodes and evidence-backed relationships as the first step of /explore. Use when mapping a local repository before drilling into a selected flow.
user-invocable: true
---

# Explore Architecture Discovery

Map the requested local repository area as a first-pass architecture view. This is a read-only exploration, not a CALM model generator or a deterministic inventory tool.

## Discovery

- Scan the requested root and its relevant subdirectories with the available read-only file and search tools. Keep the survey cursory; do not claim complete coverage.
- Look for evidence in package and build manifests, deployment and runtime configuration, executable source, and API specifications when present.
- Do not use documentation, comments, unused constants, or names alone as primary evidence. Prefer active source and configuration that show components running or communicating.
- Identify a node only when evidence supports a distinct runtime process, deployable component, client, data store, or external system. Classes and modules within one runtime are not separate nodes.
- Include external identity, monitoring, logging, or other services only when active code or configuration references them.
- Identify directed relationships that evidence shows between nodes. Label them with concise actions such as calls, reads, writes, publishes, or subscribes. Do not invent protocols or deployment boundaries.
- Treat the taxonomy as descriptive rather than schema-bound: use labels such as client, service, worker, database, system, external system, or data asset when they fit the evidence.

## Output

1. Draw a concise static ASCII map of the discovered nodes and their relationships. Give each node a stable number such as `[1]` and label arrows with a short interaction. Group related nodes when that makes the map easier to read, without implying an unsupported deployment boundary.
2. Add `Node annotations:` with one line for every numbered node, formatted `- [1] Short name — role; source: path:line`. Include best-effort local source references when available. Keep the role concise.
3. Add brief key observations about runtime boundaries, trust boundaries, external dependencies, and nodes that may be worth exploring further. Mark uncertain conclusions as uncertain.
4. Add `Flow candidates:` with three to five user-selectable behaviors, each formatted `- [Flow] Short name — brief description`. Ground these in the discovered nodes and relationships.

The ASCII node map is static. The Explore interface lets the user page through node annotations and select a Flow for a separate, focused investigation. Keep node citations as local `path:line` text; do not create GitHub links.

Do not generate a CALM schema, save architecture files, modify the repository, or claim that the discovered inventory is complete. Business or sequence diagrams are a separate follow-up skill and are not part of this discovery skill.
