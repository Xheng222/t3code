import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import { T, Var } from "gt-react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";

export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Mount it only when `useCommandOutputStreaming` holds
 * or a `source` serves the output.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const input = { threadId: props.threadId, itemId: props.itemId };
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(
    props.source
      ? props.source(input)
      : orchestrationEnvironment.v2.commandOutput({ environmentId: props.environmentId, input }),
  );
  useInitialOutputReady(data === null && !error, props.onInitialOutputReady);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();

  if (text.length === 0) {
    if (error) {
      return (
        <div className="text-destructive">
          <T>
            Couldn&apos;t load output: <Var>{error}</Var>
          </T>
        </div>
      );
    }
    if (data === null) {
      return (
        <div className="text-muted-foreground italic">
          <T>Loading output…</T>
        </div>
      );
    }
    return (
      <div className="text-muted-foreground italic">
        {data.running ? <T>Waiting for output…</T> : <T>No output.</T>}
      </div>
    );
  }
  // Parse after all hooks to preserve the text/theme compiler cache.
  const spans = terminalOutputSpans(text, TERMINAL_PALETTES[resolvedTheme]);
  return (
    <div className="min-w-0 wrap-anywhere text-muted-foreground">
      {data?.output.truncated ? (
        <div className="italic">
          <T>Earlier output not shown</T>
        </div>
      ) : null}
      {spans.map((span, index) =>
        span.style === null ? (
          span.text
        ) : (
          // Spans never reorder and are rebuilt on each update.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} style={span.style}>
            {span.text}
          </span>
        ),
      )}
    </div>
  );
}
