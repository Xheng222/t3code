---
change: ywkrntyn
retention: permanent
summary: "Web/desktop tool output shows in full beneath its call, without nested scrollers."
---

# Tool output

## Behavior

Command and tool output render at full length in the timeline, wrapping long lines anywhere, beneath the call in a group marked `└─`. A running call with no output yet shows "Waiting for output…"; a finished one with none shows "No output." Upstream's `BackgroundWorkDetails` also renders `CommandOutputPanel`, so its output loses the bounded scroller too. File search results list every matched file at full length as well.
