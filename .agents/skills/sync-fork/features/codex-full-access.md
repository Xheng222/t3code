---
change: wvzzurso
retention: permanent
summary: "Codex Full access: accepts every approval Codex still raises, such as rule, skill, and permission prompts, instead of letting Codex refuse them or asking the user."
watch:
  - apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
---

# Codex full access

## Behavior

Full access never stops for an approval and never has one refused. Commands and edits run in the unrestricted sandbox, and T3 accepts each prompt Codex still raises, such as an exec rule that asks before a command, a skill approval, a permission request, or browser and app access, without showing it to the user. A rule's `prompt` decision therefore runs without asking in Full access; `forbidden` rules still block. Each acceptance covers that request only, so switching to another mode asks again.

## Upstream files

- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: `codexRuntimeModeTurnDefaults` gives `full-access` the `on-request` policy instead of upstream's granular policy, which lets only MCP elicitations through and makes Codex refuse the other prompts. The command, file-change, and permission request handlers, including the legacy `execCommandApproval` and `applyPatchApproval`, accept in Full access before the session allowance, as upstream's elicitation handler already does. They do not accept when the turn carries an explicit Codex approval policy, as the approval replay fixtures do, since Codex then is not running Full access. When upstream changes this file without a conflict, check that no new path sends `never` or the granular policy for Full access, such as thread start or child threads, and that every approval request handler, including a new one, accepts in Full access.
- `packages/effect-codex-app-server/src/replay.ts`: replay frame normalization drops `on-request` with the unrestricted sandbox as it drops upstream's Full access policies, so recordings of either match. A recorded `on-request` with another sandbox still compares.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`: the Full access turn parameters and replay fixtures expect `on-request`; a Full access turn accepts each request kind without a pending request; the file-change approval path tests run in `approval-required` so they still get a prompt to answer.
