# Explore Mode: Implementation Work Items

This handoff breaks down the MVP recorded in [ADR 0001](./adr/0001-exploration-uses-agent-loop.md) and uses the terms in [GLOSSARY.md](../GLOSSARY.md). It is intended for parallel implementation handoff, with dependencies listed explicitly.

## 01: Start read-only repository exploration

**What to build:** Running `/explore` starts a read-only investigation of the repository root. An optional path narrows the starting scope. The user sees an ASCII architecture overview and flow candidates in the normal Pi session.

**Blocked by:** None (can start immediately).

**Status:** implemented in `feat(coding-agent): add read-only Explore overview`

- [x] `/explore` starts collecting repository context immediately; without an argument it starts at the repository root, and with a path it starts at that path.
- [x] The investigation runs through Pi's regular agent loop, so its prompt, tool calls, and responses remain visible in the session transcript.
- [x] Only built-in read and search tools are available during the exploration; shell, write, edit, and custom tools are unavailable.
- [x] The previous active tool set is restored when the user exits or cancels exploration.
- [x] The overview is an ASCII architecture sketch with a short list of Flow candidates. Source citations are optional and do not block display.

## 02: Choose a flow and generate its sequence diagram

**What to build:** Selecting a Flow candidate starts a focused read-only investigation and displays its sequence diagram. The user can return to the overview and choose another flow.

**Blocked by:** 01: Start read-only repository exploration.

**Status:** implemented in `feat(coding-agent): add Flow selection and annotation navigation`

- [x] The user can select a Flow candidate from the overview to start a second investigation through Pi's regular agent loop.
- [x] The selected flow is displayed as a static ASCII sequence diagram with its participants and ordered interactions.
- [x] Branches that change the flow's outcome appear in the diagram; smaller alternatives are summarized in Diagram annotations.
- [x] The user can return to the overview and select a different Flow candidate without leaving exploration.
- [x] Read-only restrictions remain active while moving between the overview and sequence diagrams.

## 03: Navigate diagram annotations

**What to build:** The user can move through Diagram annotations while the sequence diagram remains static, and see each annotation's description and any available local source reference.

**Blocked by:** 02: Choose a flow and generate its sequence diagram.

**Status:** implemented in `feat(coding-agent): add Flow selection and annotation navigation`

- [x] Up and down navigation selects the annotations associated with diagram elements without changing the diagram layout.
- [x] The selected annotation's description is displayed below the diagram.
- [x] When supplied by the model, local source references are displayed as best-effort `path:line` citations; citations are not validated and do not need to open a file.
- [x] The user can return to the Flow candidate list after reviewing annotations.
