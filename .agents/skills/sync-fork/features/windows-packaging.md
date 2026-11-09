---
change: nnrymzvu
retention: permanent
summary: "Windows packaging: exclude duplicate resource-monitor binaries from app.asar and accommodate the prepared server cache in the payload file budget."
---

# Windows packaging

## Behavior

The Windows installer builds on a Windows host and passes payload validation. There the `afterPack` hook (`scripts/prepare-server-compile-cache.cjs`) writes the server's compile cache into the payload, and the file limit leaves room for it; upstream builds Windows on Linux runners, where the hook skips that step and the payload stays under upstream's limit. The resource monitor ships only as an extra resource, not inside app.asar as well.
