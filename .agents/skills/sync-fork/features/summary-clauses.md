---
change: vonpypsp
retention: temporary
summary: "Activity summaries join their clauses through separators of their own, so Chinese separates clauses with a comma instead of 和."
watch:
  - packages/client-runtime/src/work-log/presentation.ts
---

# Summary clauses

## Behavior

A collapsed tool group's summary joins its clauses with messages whose context is "clauses of an activity summary", every separator included, so no clause keeps a hard-coded English comma and a locale can separate clauses differently from a list of names. Chinese separates them with 「，」. Integration names inside a clause keep upstream's list messages, so Chinese still joins them with 和.

## Upstream coverage

This is the fork's wording preference, kept temporary so upstream changes to summary wording get compared. It is covered only when the user judges upstream's Chinese summaries clearly better; until then, keep this change.

## Upstream files

- `packages/client-runtime/src/work-log/presentation.ts`: `joinNames` keeps upstream's join for integration names; `joinClauses` gives every clause separator its own message. When upstream changes how `summarizeToolGroup` words or joins its clauses, compare both sides' Chinese summaries and bring them to the user, recommending this change unless upstream's is clearly better.
- `packages/client-runtime/src/work-log/presentation.test.ts`: a `summarizeToolGroup` case resolves the clause messages to a comma and checks two and three clauses.
- `apps/{web,mobile}/src/i18n/translations/*.json`: the three clause messages, inserted after the opening `{`. Chinese uses 「，」; the other locales keep the wording of their list messages.
