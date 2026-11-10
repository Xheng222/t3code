---
change: wvzzurso
retention: permanent
summary: "Codex Full access: runs with the `on-request` approval policy in the unrestricted sandbox, so rule, skill, and permission prompts Codex still raises reach the user instead of being refused."
watch:
  - apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
---

# Codex full access

## Behavior

Full access runs Codex with the `on-request` approval policy and an unrestricted sandbox, so rule, skill, and permission prompts Codex still raises reach the user for review instead of being refused. Commands and edits run without prompts, and browser and app access prompts are accepted automatically, as upstream's Full access does.

## Upstream files

- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: `codexRuntimeModeTurnDefaults` gives `full-access` the `on-request` policy instead of upstream's granular policy, which lets only MCP elicitations through and refuses the other prompts. Upstream's elicitation handler accepts MCP elicitations in Full access, and that stays. When upstream changes this file without a conflict, check that no new path sends `never` or the granular policy for Full access, such as thread start or child threads.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`: the Full access turn parameters and replay fixtures expect `on-request`.
