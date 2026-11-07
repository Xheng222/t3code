# Build and release

A release publishes a Windows x64 nightly from `Xheng222/t3code` on GitHub, whose installs update from that repository. A local installer, built after a push without a release, updates this machine. Publish only when the user asks for a release, and leave installation to the user.

## GitHub release

The `github` remote is the fork repository, with the stack on its default branch `fork`. Upstream workflows stay in the repository, disabled in GitHub; `Fork release` (`.github/workflows/release.fork.yml`) is the only enabled workflow.

1. Push the stack with `jj git push --remote github --bookmark fork`. Always name the bookmark or tag: the local repository holds upstream's tags, which must not reach the fork.
2. Run `gh workflow list --all --repo Xheng222/t3code` and disable every enabled workflow except `Fork release` with `gh workflow disable <id> --repo Xheng222/t3code`; a sync can add upstream workflows, which start enabled.
3. Tag the release `v<version>-nightly.<YYYYMMDD>.<n>`, where `<version>` is `apps/desktop/package.json`'s version with its patch number raised by one, the date is today in UTC, and `<n>` is the next number unused for that date among the repository's tags and the installers in `release/`. Push it straight from the commit with `git push github <fork commit ID>:refs/tags/<tag>`. Never create the tag with jj or push it with `jj git push`: jj treats every local tag and every remote tag it records as immutable, which would freeze the stack against the next sync. If jj has recorded one, `jj op revert` the operation that did.
4. Wait for the tag's `Fork release` run with `gh run watch <run id> --repo Xheng222/t3code --exit-status`. When no run starts within a few minutes, delete the remote tag with `git push github :refs/tags/<tag>` and push it again. A failed run publishes nothing; fix the cause, delete the remote tag, and tag again.
5. Write the upstream brief as the release notes with `gh release edit <tag> --notes-file <file> --repo Xheng222/t3code`, then refresh the pointer, which carries the notes: `gh api repos/Xheng222/t3code/releases/tags/<tag> --jq '{tag_name, name, body}' > nightly.json` and `gh release upload update-feed nightly.json --clobber --repo Xheng222/t3code`.
6. Verify that the run log shows the Windows payload validation, the release is a prerelease that is not latest and carries the installer, its blockmap, and `nightly.yml`, `nightly.yml` names the new version and installer, and `update-feed`'s `nightly.json` names the new tag.

Report the release URL and the installer's signing, update, and WSL properties.

## Local installer

Compile the resource monitor separately with Cargo, then import its binary during packaging. Match the Cargo target and desktop architecture. Load T3 Connect's public config from `.env.example`, the same identifiers official releases bake in; a build without it disables T3 Connect. Name the fork as the update repository, as `Fork release` does; without it the install never updates. For Windows x64:

```powershell
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-pc-windows-msvc
Get-Content .env.example | Where-Object { $_ -match '^(T3CODE_[A-Z_]+)=(.+)$' } | ForEach-Object { Set-Item "env:$($Matches[1])" $Matches[2] }
$env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR='true'
$env:T3CODE_DESKTOP_UPDATE_REPOSITORY='Xheng222/t3code'
$env:T3CODE_DESKTOP_VERSION='<version>-nightly.<YYYYMMDD>.<n>'
vp run dist:desktop:win --arch x64
```

Name the version as step 3 of the GitHub release names a tag, without the `v`. Build the client and server normally; do not pass `--skip-build`.

Verify the packaged client and server retain the fork features and that Windows payload validation passes. After validating the new installer, delete all older release artifacts from the output directory, retaining only the new version and its associated files.

Report the installer path and its signing, update, and WSL properties.
