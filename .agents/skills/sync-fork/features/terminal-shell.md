---
change: psmylmrr
retention: permanent
summary: "Settings > General > Terminal > Shell picks the executable that new interactive terminals start on each environment, ahead of T3CODE_TERMINAL_SHELL."
watch:
  - apps/server/src/project/ProjectSetupScriptRunner.ts
---

# Terminal shell

## Behavior

The Shell row (server setting `terminalShell`, empty by default) takes an executable name or full path without arguments, such as `nu`. New interactive terminals on that environment start it; an empty value falls back to `T3CODE_TERMINAL_SHELL`, then the platform default. Upstream's handling of the chosen executable stays: known shells get their startup arguments, and a shell that fails to start falls back through the usual candidates. Project setup and settle scripts keep the default shell, and a running terminal keeps its shell until it restarts. A server without this change ignores the setting.

## Upstream files

- `packages/contracts/src/settings.ts`: adds `terminalShell` to server settings and their patch.
- `apps/server/src/terminal/Manager.ts`: `make` passes the setting as the `terminalShell` option, empty when settings cannot be read. At spawn, a terminal's own `T3CODE_TERMINAL_SHELL` comes first, then the setting, then the server's environment variable.
- `apps/server/src/terminal/Manager.test.ts`: the script terminal test sets the setting beside the environment variable, so the interactive terminal starts the setting's shell while the script terminal keeps the default.
- `apps/web/src/components/settings/SettingsPanels.tsx`: a Terminal section holding `TerminalShellRow` ends the General page.
- `apps/web/src/components/settings/settingsSearch.ts`: the `terminal-shell` search entry.
- `apps/web/src/i18n/translations/*.json`: the row's four messages, inserted after the opening `{`.
- `apps/server/src/project/ProjectSetupScriptRunner.ts`, watched only: script terminals pass an empty `T3CODE_TERMINAL_SHELL` to keep the default shell, which the setting must not override. When upstream changes how scripts choose their shell, check that a set Shell still leaves setup and settle scripts on the default.
