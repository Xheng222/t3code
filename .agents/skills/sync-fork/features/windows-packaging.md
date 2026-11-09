---
change: nnrymzvu
retention: permanent
summary: "Windows packaging: exclude duplicate resource-monitor binaries from app.asar and leave the prepared server compile cache out of the payload file budget."
---

# Windows packaging

## Behavior

The Windows installer builds on a Windows host and passes payload validation. There the `afterPack` hook (`scripts/prepare-server-compile-cache.cjs`) writes the server's compile cache into the payload, one file per server chunk loaded at startup; upstream builds Windows on Linux runners, where the hook skips that step. The file count leaves `resources/server-compile-cache` out, so the rest of the payload keeps upstream's limit however many chunks upstream splits the server into. The resource monitor ships only as an extra resource, not inside app.asar as well.
