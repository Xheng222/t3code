---
name: update-fork-changes
description: Use after creating or changing a local T3 Code fork commit, or when updating sync-fork or update-fork-changes.
---

# Update the fork change documents

Each local commit has one document in `../sync-fork/features/`, in the format [sync-fork](../sync-fork/SKILL.md#change-documents) describes. After a local fork commit changes:

1. Inspect `git status --short`, `jj log -r 'main@origin..@'`, and the affected commits with `jj show <change-id>`.
2. Keep one document per local commit, named for its work, with its stable jj change ID, and add or update it in that commit. When commits are split or squashed, move the documents with their work and update their metadata. After adding a local commit on top, run `jj bookmark move fork --to <change-id>`. After splitting, squashing, or moving work between commits, check each rewritten commit on its own: typecheck its packages, run knip, and run its change's tests. Tests that fail only on Windows are handled as [sync-fork](../sync-fork/SKILL.md#6-verify) describes.
3. Record the work and its established retention: permanent changes survive upstream updates; temporary fixes remain until equivalent upstream behavior is verified.
4. Describe the behavior conflict resolution must preserve, concise and current, without file lists or implementation history.
5. When the commit's upstream edits are more than its diff explains, add Upstream files with an entry for every path in `jj diff -r <change-id> --name-only` outside `.fork` files and the document. Where a hook keeps upstream changes from conflicting, list those paths in `watch` and give their entries a check.

Edit upstream files in place. Move fork code into a `.fork` file beside an upstream file only when the fork would otherwise rewrite most of that file, and leave a short hook there. A new unit with no upstream counterpart, such as a new service, goes in its own `.fork` file. Change the other sync-fork documents only when the workflow itself changed.

User-facing text a fork commit adds goes through upstream's i18n: the commit inserts its catalog keys, generated as [sync-fork](../sync-fork/SKILL.md#6-verify) describes, right after the opening `{` of every locale catalog, translated. Screen-reader-only labels and settings search keywords keep their English value.

Squash every update to `sync-fork`, its shared documents, or `update-fork-changes` into `vxtynpkv`, the oldest local commit. The global git ignore excludes `.agents/`, so track a new file there with `jj file track --include-ignored <path>`.
