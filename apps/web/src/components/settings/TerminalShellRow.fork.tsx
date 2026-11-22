import { resolvePastedPath } from "@t3tools/shared/path";
import { useGT } from "gt-react";
import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function TerminalShellRow() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalShell"]);
  const edited = useRef(false);
  const draft = useRef("");
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...setting("terminal-shell")}
      description={gt(
        "Program new terminals start, as a name or full path without arguments, such as nu or pwsh. Leave empty to use the default shell.",
      )}
      serverScoped
      settingKeys={["terminalShell"]}
      resetAction={
        mixed || settings.terminalShell !== "" ? (
          <SettingResetButton
            ariaLabel={gt("Reset shell to default")}
            onClick={() => updateSettings({ terminalShell: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.terminalShell}`}
          aria-label={gt("Shell")}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? gt("Mixed") : gt("Default")}
          defaultValue={mixed ? "" : settings.terminalShell}
          onFocus={(event) => {
            draft.current = event.target.value;
          }}
          onChange={(event) => {
            edited.current = true;
            draft.current = resolvePastedPath(draft.current, event.target.value);
            event.target.value = draft.current;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.terminalShell))
              updateSettings({ terminalShell: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}
