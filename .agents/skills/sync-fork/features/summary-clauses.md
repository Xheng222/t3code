---
change: vonpypsp
retention: temporary
summary: "Activity summaries join their clauses through translatable separators of their own, so Chinese separates clauses with a comma."
---

# Summary clauses

## Behavior

A collapsed tool group's summary joins its clauses with messages whose context is "clauses of an activity summary", every separator included, so no clause keeps a hard-coded English comma and a locale can separate clauses differently from a list of names. Chinese separates them with 「，」. Integration names inside a clause keep upstream's list messages, so Chinese still joins them with 和.

## Upstream coverage

Covered when upstream's `summarizeToolGroup` routes every clause separator through translatable messages that name lists do not share. Its Chinese translation may differ from 「，」; bring that to the user.
