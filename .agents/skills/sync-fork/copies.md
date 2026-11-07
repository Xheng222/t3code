# Port copied components

`apps/web/src/components/chat/copies.fork.json` lists the upstream components the fork copied, each with its source path and the upstream commit it was last merged from. Port a copy whose source upstream changed in the commit that creates the copy:

1. Review `jj log --no-graph -r '<upstream>..main@origin' -T builtin_log_oneline <source>`.
2. Run `jj new <creating commit>`. Write the source at `<upstream>` and at `main@origin` to temporary files with `jj file show -r <revision> <source>`, since Git for Windows cannot read process substitution, then merge three ways: `git merge-file <copy> <upstream file> <main@origin file>`.
3. Resolve, set `upstream` to the `main@origin` commit, and squash into the creating commit; jj rebases the later edits over it.
