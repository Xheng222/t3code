---
change: ssookxpr
retention: permanent
summary: "Thread details shows the API cost estimate for a thread and its local subagents."
---

# Thread API estimate

## Behavior

On web and desktop, top-level threads show **API estimate** between **Usage limits** and **Context window**. The row starts enabled in **Appearance → Thread details**.

The estimate includes the current thread and every level of its subagents in the same T3 environment. Repeated delegation to the same child counts once. Codex and Claude Code requests use the same prices and deduplication rules as **Usage**, including cache reads and writes. An asterisk marks a partial amount when some usage is missing or unpriced.

Hovering over the info icon shows the scope. For a partial estimate, the tooltip starts with the reason.
