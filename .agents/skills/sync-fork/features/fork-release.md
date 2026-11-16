---
change: oluokpop
retention: permanent
summary: "GitHub release: a pushed nightly tag builds the Windows x64 installer on GitHub Actions and publishes it as a prerelease, which installs from this repository update from."
watch:
  - scripts/build-desktop-artifact.ts
  - .github/workflows/release-desktop.yml
---

# Fork release

## Behavior

Pushing a tag `v<x.y.z>-nightly.<YYYYMMDD>.<n>` runs `.github/workflows/release.fork.yml` on a GitHub-hosted Windows runner. It builds the unsigned Windows x64 installer with T3 Connect's public config from `.env.example`, sets this repository as the update source, publishes the installer, its blockmap, and `nightly.yml` as a prerelease that is never latest, and points the `update-feed` release's `nightly.json` at it. The installer carries no WSL runtime. Upstream workflows stay in the repository, disabled in GitHub.

## Upstream files

- `scripts/build-desktop-artifact.ts`, watched only: the workflow relies on `T3CODE_DESKTOP_VERSION`, `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR`, and `T3CODE_DESKTOP_UPDATE_REPOSITORY`, the resource monitor's Cargo output, and the `release/T3-Code-<version>-x64.exe`, blockmap, and `nightly.yml` outputs. When upstream changes this file, check that these still hold.
- `.github/workflows/release-desktop.yml`, watched only: upstream's Windows packaging. When upstream changes how it packages Windows, check whether the fork workflow needs the same change.
