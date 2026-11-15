---
change: mlkwlwlo
retention: permanent
summary: "Provider sessions idle for one hour before the server releases them; the next message resumes the thread."
---

# Idle session release

## Behavior

A provider session with no running turn is released after one hour idle, and a thread on a shared runtime unloads after the same hour (`DEFAULT_IDLE_TIMEOUT_MS`). A released Claude session ends its CLI process, and the next message resumes the conversation. Pending background work still defers the release, up to its own four hour limit, which stays as upstream sets it.
