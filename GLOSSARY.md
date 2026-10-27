# Pi Codebase Exploration

This context describes the concepts used when exploring a repository in Pi and navigating its architecture and flows.

## Language

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
