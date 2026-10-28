# Battlestar

Battlestar is an opinionated fork of pi: a coding-agent harness that ships one way of planning and executing work.

## Language

**Harness**:
The battlestar-pi distribution as the user runs it, with its own identity and global configuration separate from stock pi, including its built-in workflow, skills, and tracker integration.
_Avoid_: Pi system, setup, config

**Plan mode**:
The harness's collaborative planning workflow, available in every session and entered on demand.
_Avoid_: Planning mode, read-only mode

**Plan-mode proposal**:
The agent's offer to enter plan mode for the current request, which takes effect only when the user accepts.
_Avoid_: Auto plan, plan trigger

**Core skills**:
The fixed set of skills plan mode draws on: grill-with-docs, grilling, domain-modeling, to-tickets, handoff, tdd, code-review, diagnosing-bugs, codebase-design, and beads. They ship with the harness but belong to plan mode, not to ordinary sessions.
_Avoid_: Required skills, bundled skills, default skills

**Tracker**:
Where published tickets and their dependency edges live: Beads when available, otherwise Markdown files.
_Avoid_: Issue system, backlog

**Markdown tracker**:
The filesystem fallback tracker, used when Beads is missing, unusable, or declined for a repository.
_Avoid_: Markdown tickets, fallback tickets

**Beads opt-out**:
A user's recorded refusal to initialize Beads in a repository, after which the harness no longer offers to.
_Avoid_: Declined init, no-beads flag

**Exploration**:
A read-only guided investigation that maps repository architecture as runtime nodes and relationships, then lets the user inspect a selected code flow.
_Avoid_: Browse mode

**Architecture node**:
A distinct runtime process, deployable component, client, data store, or external system supported by source or configuration evidence. A class inside a runtime component is not a separate node.
_Avoid_: Code symbol

**Architecture relationship**:
An evidence-backed, directed interaction between architecture nodes, such as a call, read, write, publish, or subscribe.
_Avoid_: Dependency (when direction or interaction is unknown)

**Flow candidate**:
A behavior identified in the architecture overview as a possible subject for a detailed sequence diagram.
_Avoid_: Candidate, scenario

**Diagram annotation**:
A selectable note associated with a diagram element, describing its role and optionally pointing to source code.
_Avoid_: Label, footnote
