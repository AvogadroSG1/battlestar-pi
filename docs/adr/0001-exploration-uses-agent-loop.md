# Exploration uses the regular agent loop

## Context

Explore guides a user from a repository overview to a selected code flow. Its findings should appear in the ordinary Pi conversation, and the investigation should use the user's configured model and the same tool and session lifecycle as other requests. The first version is exploratory: it does not require a deterministic repository inventory or a separate analysis backend.

The extension API can start normal agent turns, change the active tool set, and provide native TUI selectors, widgets, and shortcuts. A private runner or a new core mode would add another execution path before Explore needs one.

## Decision

Implement `/explore` as a built-in coding-agent extension. Run both the architecture overview and selected Flow investigation through Pi's regular agent loop. Limit the active tools to built-in read and search tools until the user exits or cancels Explore, then restore the prior tool set.

Generate the overview and sequence diagrams as ASCII in the normal transcript. Use Pi's native Flow selector, annotation widget, and shortcuts to navigate them. Treat the model's repository inventory and `path:line` citations as best effort; do not validate or open citations in this MVP. Start at the current repository root, with an optional in-repository path to narrow the scope.

## Alternatives considered

- **Private analysis runner:** would isolate Explore state, but would duplicate the agent lifecycle and hide the investigation from the normal transcript.
- **Deterministic inventory or provider first:** could make repository structure more repeatable, but would delay a useful interactive prototype. A deterministic backend can be added later behind the exploration workflow.
- **Mermaid or a separate diagram renderer:** would require rendering support outside Pi's ordinary text conversation. ASCII keeps diagrams visible in the existing terminal interface and is sufficient for the first version.

## Consequences

- Users see the overview, tool calls, and selected-flow investigation in the session transcript and can use the configured model.
- Repository coverage and flow selection depend on model judgment. The overview may miss components or flows; local citations may be incomplete or inaccurate.
- Read-only behavior is enforced by the active tool set and a tool-call guard, and Explore restores the previous tool set on exit or cancellation.
- The first version displays source references as text. It does not open files from annotations, create GitHub links, or use a deterministic inventory service.
