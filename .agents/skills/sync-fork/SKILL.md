---
name: sync-fork
description: Use when syncing this T3 Code fork with upstream, or building a local installer from the fork.
---

# Sync the fork

Rebase the local fork stack onto upstream, keeping permanent fork changes and dropping temporary fixes that upstream now covers. Fork code edits upstream files in place, except where it would rewrite most of a file: that code lives in a `.fork` file and the upstream file keeps a short hook, so conflicts land in the hook.

The stack is `vxtynpkv::fork`, oldest first: the skills, permanent changes, then temporary fixes. The `fork` bookmark marks the newest local change; the empty working-copy child stays above it. Squash every update to this skill, its shared documents, or `update-fork-changes` into `vxtynpkv`.

## Change documents

Each local commit has one document in `features/`, added and updated in that commit, so it moves, splits, and goes away with the commit. Its frontmatter carries:

- `change`: the jj change ID;
- `retention`: `permanent`, kept whatever upstream does, or `temporary`, kept until upstream covers it;
- `summary`: what the change does;
- `watch`, optional: upstream paths whose changes can affect the change without a conflict.

Its body has:

- `## Behavior`: what conflict resolution must preserve, in user-visible terms;
- `## Upstream coverage`, for a temporary change: what equivalent upstream behavior looks like;
- `## Upstream files`, for a change whose upstream edits the diff does not explain, and for every change with `watch`: an entry for each upstream path the commit edits or watches, saying what the fork does there and what to keep through a conflict, and for a watched path, what to check when upstream changes it without one.

Read the metadata of all documents with `rg -H '^(change|retention|summary):' .agents/skills/sync-fork/features`, and a whole document only when a step calls for it.

## 1. Fetch upstream

Inspect the working tree with `git status --short` and the stack with `jj log -r 'main@origin..@'`. Note the current base, `vxtynpkv`'s parent, then fetch:

```powershell
jj git fetch --remote origin --branch main
```

## 2. Check temporary fixes

For each document with `retention: temporary`, read its Upstream coverage and check the fetched upstream implementation and tests for equivalent behavior.

If upstream fully covers a fix, inspect its commit for unrelated content, preserve that content separately, then run `jj abandon --retain-bookmarks <change-id>`; its document goes with it. Otherwise retain or adapt the fix.

## 3. Rebase onto main

Keep the skill as the oldest local change and rebase the stack:

```powershell
jj rebase -s vxtynpkv -d main@origin
```

Preserve the change IDs and the working-copy child.

## 4. Resolve conflicts

List conflicts with `jj resolve --list -r <change-id>` from the oldest conflicted commit up. Scope `git status` to affected project paths while conflicts remain to avoid synthetic `.jjconflict-*` entries.

Before resolving a commit's conflicts, read its document, including the Upstream files entry of each conflicted file, and understand the upstream changes; a conflict-free rebase alone does not establish compatibility.

Where upstream now covers or changes behavior that a fork change also implements, keep the fork's behavior through the rebase, then compare both sides: user-visible behavior, edge cases, performance, code size, and future sync cost. Read both implementations and their tests, run both when behavior is in question, and bring the user each side's pros and cons with a recommendation. The user decides which to keep.

## 5. Check what conflicts miss

- List upstream's changed paths with `jj diff --from <old base> --to main@origin --name-only`. For each `watch` path among them, run the check in its document's Upstream files entry.
- For each entry in `apps/web/src/components/chat/copies.fork.json`, run `jj log --no-graph -r '<upstream>..main@origin' -T builtin_log_oneline <source>`. When upstream changed a copied component's source, port the copy as [copies.md](copies.md) describes.
- List upstream's client performance changes with `jj log --no-graph -r '<old base>..main@origin & subject(regex-i:"perf|render")' -T builtin_log_oneline apps/web packages/client-runtime packages/shared`. For each that changes code a fork file copies, mirrors, or replaces, as `copies.fork.json` and the change documents name them, check that the fork's path still gets the change, and port it where it does not.

## 6. Verify

Run `vp i` when dependency inputs change. Check what the sync can break, not the whole fork:

- Format and lint the files the fork changes (`jj diff --from main@origin --to @ --name-only`), and typecheck their packages with `vp run typecheck` from each package directory.
- Run the `.fork` test files of the affected changes, the tests beside each conflict resolution, and the upstream test cases the fork edits, by file or name (`vp test run <file> -t <name>`). Verify that the selected tests actually ran.
- Run knip from the repository root: `vp exec knip --workspace apps/web --exports --preprocessor ./scripts/knip-schemas.ts --no-config-hints`. Hooks keep bypassed upstream code referenced; knip shows when an upstream change leaves some of it unused.
- When upstream changes client rendering or the sync touches the timeline, compare render counts on the old and new fork tips. From `apps/web`, run `T3CODE_RENDER_REPORT_DIR=<dir> vp test run --project renders` here, and in a `jj workspace add -r <old fork tip>` checkout after `vp i`. A count that rises is a regression; an assertion that fails on both tips is the fork's own cost. The React Compiler stops memoizing a component without a warning, and only these counts show it. `MarkdownSource` and commit counts vary between runs. Afterwards run `jj workspace forget`, abandon the old stack the checkout made visible again (it shows as divergent), and delete the directory with `rmdir /s /q`, which leaves pnpm's junctions' targets alone.

Upstream test cases that fail only in this Windows environment are not sync regressions; leave them out rather than reproducing them on the base.

## 7. Report

Report the upstream base, the retained change IDs, check results, and each divergence awaiting the user's decision. When the user asks for a release or a local installer, follow [release.md](release.md).

## 8. Brief upstream changes

After the report, and after the release or installer when the user asks for one, brief the user on what upstream changed since the old base. A release takes the brief as its notes, as [release.md](release.md) describes.

- List the commits with `jj log --no-graph -r '<old base>..main@origin' -T 'description.first_line() ++ "\n"'`, and open with their count by type.
- Pick the changes that matter to how the user runs T3 Code: the Windows desktop app, Codex and Claude, delegated tasks, and performance. Group them by area, give each its user-visible effect and PR number, and point out those that touch a fork change.
- Name upstream's new migrations under `apps/server/src/persistence/Migrations` and what they cost on first launch.
- Give mobile, other providers, and the remaining fixes a line each.
