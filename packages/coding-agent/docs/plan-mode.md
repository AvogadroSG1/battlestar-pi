# Plan Mode Extension

Plan Mode is a built-in collaborative planning extension, enabled by default. It adds `/plan`, `/plan-execute`, the `--plan` flag, and the `plan_phase`, `plan_readiness`, `plan_confirm`, `plan_tickets`, and `plan_schedule` tools. Disable it with `-builtin:plan-mode` in the `extensions` setting. While Plan Mode is active, the agent cannot edit or write files and bash is limited to read-only commands.

## Commands

- `/plan` - Start plan mode. When plan mode is already active, opens a menu: Continue planning or Exit Plan Mode.
- `/plan-execute` - Hand off the agreed schedule. Works only in the `ready` phase with the schedule agreed; otherwise it reports an error and stays in plan mode. See Scheduling and Handoff.
- `Ctrl+Alt+P` - Same as `/plan`.
- `--plan` flag - Start the session in plan mode.

## Phases

`plan_phase` accepts these names: `readiness`, `grilling`, `confirming`, `ticketing`, `reviewing`, `scheduling`, `ready`. Any other name is rejected with an error that lists the known phases. Plan mode starts in `readiness`. The phase is shown in the footer as `plan: <phase>` and survives session resume.

Phase steps:

- `readiness`: the agent judges whether the request is ready for ticketing and calls `plan_readiness` with a `grill` or `ticket` recommendation and a one-line rationale. The user agrees or picks the other path; dismissing the menu follows the recommendation. `grill` moves to `grilling`; `ticket` moves to `confirming`.
- `grilling`: requirements are explored with the bundled `grill-with-docs`, `grilling`, and `domain-modeling` guidance. These private resources are included only while Plan Mode needs them; they are not registered as user skills. The agent does not write a numbered plan.
- `confirming`: the agent calls `plan_confirm` with kind `outcome` (desired outcome and constraints) and kind `system_model` (system and domain model). The user confirms or declines each summary. A declined summary returns the workflow to `grilling`.
- `ticketing`: `plan_phase` refuses this phase until both `outcome` and `system_model` are confirmed. The agent drafts tickets with the bundled `to-tickets` guidance and submits them with `plan_tickets`, action `submit_drafts` (see Tickets below).
- `reviewing`: entered by a valid `submit_drafts`. The agent asks the user whether the granularity is right and whether each blocker is a real dependency, revises with `submit_drafts` until the user agrees, then calls `plan_tickets` with action `approve`.
- `scheduling`: entered by a successful `publish`. The agent calls `plan_schedule` with action `propose`, presents the order and parallel waves, then calls `plan_schedule` with action `agree` once the user confirms. Agreement moves to `ready`.

Returning to `grilling` from a later phase needs a `reason` that names the undecided requirement. The return clears both confirmations. A return from `ticketing` or later also sets `reReviewRequired`, so drafted tickets must be submitted again before publication. A valid `submit_drafts` clears the flag. `plan_phase` cannot move to `reviewing`, `scheduling`, or `ready`.

The confirmations, `reReviewRequired`, the drafts, their approval, and the last publication result are saved with the phase and restored on resume.

## Tickets

`plan_tickets` takes an `action`:

- `submit_drafts` (in `ticketing` or `reviewing`): takes `epic` (`title`, `outcome`) and `drafts`. Each draft has a `key`, `title`, `whatToBuild` (the end-to-end behavior, from the user's perspective), `acceptance` (Given/When/Then scenarios), `blockedBy` (keys of other drafts), and `skills` (each with a name and one line of loading guidance). Invalid drafts are rejected with every problem listed. Valid drafts move to `reviewing`, clear any earlier approval, and clear `reReviewRequired`.
- `approve` (in `reviewing`): asks the user to confirm the current drafts. Declining leaves them unapproved.
- `publish` (in `reviewing`, approved, not re-review-pending): creates one Beads epic, then one child ticket per draft in dependency order, with a native `blocks` edge per blocker. Each ticket body holds the Given/When/Then contract, the blockers, and the skill-loading guidance. If Beads cannot create the epic (not initialized or not installed), the tickets are written instead to `tickets/`: a `README.md` index and one `<NN>-<slug>.md` per ticket with `ID:`, `Status: open`, and a `## Blocked by` list, and the user is notified. A failure after Beads has created issues throws and names the created IDs; it does not fall back, because that would duplicate them.

## Lifecycle

1. `/plan <request>` enables plan mode, disables `edit` and `write`, keeps other active tools, and sends the agent its first planning step with the request.
2. While active, every user prompt gets the plan-mode context and private skill guidance for the current phase; bash commands outside the allowlist are blocked.
3. When the phase is `ready`, the agent's turn ends with a menu:
   - Execute and clear context: sends `/plan-execute`.
   - Continue planning: nothing happens.
   - Exit Plan Mode: asks for confirmation, then exits.
4. Exiting restores the tool set saved when plan mode started and clears the footer status. It publishes no tickets and starts no implementation.

Declining the exit confirmation or dismissing a menu keeps plan mode active.

## Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

## Scheduling and Handoff

`plan_schedule` with action `propose` reads the published tickets from the tracker. Beads tickets come from `bd list --parent <epic> --all --json`, and only `blocks` edges count as blockers (parent-child edges do not). Markdown tickets come from the files in `tickets/`. Closed tickets satisfy blockers and are left out. Open tickets are layered into waves: wave 0 is ready now, and a wave is marked parallel when it holds more than one ticket. A dependency cycle or a blocker missing from the tracker is an error. Proposing again revokes any earlier agreement.

`plan_schedule` with action `agree` shows the rendered schedule and asks the user to confirm it. A declined schedule stays in `scheduling`. An agreed schedule moves to `ready`. `plan_phase` cannot reach `ready`.

`/plan-execute` needs `ready` with the schedule agreed. If the `handoff` command or `ctx.newSession` is unavailable, it reports the manual action (`/handoff` or `/new`) and stays in plan mode. Otherwise it exits plan mode first, then starts a fresh session from this one with `ctx.newSession`. It builds the handoff text itself rather than running the `/handoff` or `/new` commands; the `handoff` command is only an availability check. The fresh session's first message is the handoff: the approved schedule, the ticket references, the tracker location, a ready-to-paste JSON block of `orchestrate` `init` arguments (open tickets as `{ id, blockedBy }`, plus the tracker), and a statement that the schedule is already approved, so the user is not asked to approve it again. The fresh session calls `orchestrate` with `init` and that JSON, then starts dispatching. See Orchestration below.

## Orchestration

The `orchestrate` tool runs the handed-off tickets in the fresh session. Its state (the tracker, and each ticket's status and counters) is saved as a `plan-orchestration` session entry and restored on resume. The orchestration rules are added to each prompt while an orchestration is active, and to the handoff prompt that starts the fresh session. They are never added while plan mode is active.

Actions (`action`, plus `ticketId` where noted):

- `init`: `tickets` (`{ id, blockedBy }`) and `tracker` (`{ kind: "beads" }` or `{ kind: "markdown", dir }`). Blockers outside the list count as closed. Only one orchestration exists per session.
- `red_contract`: `testPath` and `acceptance` (Given/When/Then). Records the failing BDD test the orchestrator wrote first. A ticket needs this before dispatch, and only once its blockers are closed.
- `dispatch`: sends a contracted ticket to an implementor. Refused while blockers are open, while the ticket is paused, or without a red contract.
- `help`: an implementor asks for orchestrator help. Granted twice per ticket, then refused.
- `submit_work`: the implementor finished. Moves the ticket to verifying.
- `review`: `findings` (`{ severity: low | medium | high, message }`), empty when clean. Low-only findings verify the ticket. Medium or high findings return it for a fix, at most twice. After that, the result points to joint framing.
- `framing`: `agreed` and `pathway` (agreed), or `agreed: false` with `concern` (`none`, `destructive-data`, `security`). The joint brief is `docs/planning_support_docs/joint-framing.md`. An agreed pathway grants one more work/review cycle. Without agreement, the ticket goes to arbitration, or, for a destructive-data or security concern, pauses for the user.
- `arbitration`: `decision` from the arbitrator, or `userDecision` for a paused ticket. The arbitrator is a fresh medium-reasoning subagent that decides only from the completed joint brief. Its final report goes in `docs/escalation/`.
- `close`: only for verified tickets. Closes the ticket in the tracker first: `bd close <id>` for Beads, or `Status: open` changed to `Status: closed` in the Markdown file. A failed tracker update is an error, and the ticket stays verified.
- `status`: lists each ticket's status, and the ready, dispatchable, and paused tickets.

Every result has `details.status` (the ticket status) and `details.ready`. A paused ticket (awaiting the user), and every ticket blocked by it, waits until `arbitration` records the user's answer. Failed actions throw with the reason and leave the state unchanged.

