---
name: verify-prerequisites
description: "Use when your task builds on earlier work: it names another job, a feature step, a PR, a branch or \"after X\", asks you to extend code that should already exist, or asks you to recover work from an old or closed branch. Verifies the concrete artifacts on origin/main before you build on them, and tells you how to report blocked when they are missing. Not for tasks that are self-contained."
managed-by: gildeboek@e4b4310
---

# Verify prerequisites before building on them

A merged PR or a "finished" status does not prove the work exists: PRs holding only an empty "Blocked:" commit have been merged, and the next jobs in the chain started on code that was never written. Check the code, not the label.

## When it applies

- The task names a prerequisite: a job, feature step, PR, branch, or "after X".
- The code you are told to extend (a file, export, route, migration, config key) should already exist.
- You are asked to recover work from an old, closed or unmerged branch.

## Verify

1. `git fetch origin`, then look for the concrete artifacts on `origin/main`, never in your working tree or on the prerequisite's branch:
   - files: `git ls-tree -r --name-only origin/main -- <path>`
   - symbols, routes, config keys: `git grep -n "<symbol>" origin/main -- <path>`
   - history: `git log --oneline origin/main -- <path>`
2. Derive the artifacts from the prerequisite's task and acceptance criteria (the files, exports, routes, migrations and config it should have added), and check each one.
3. Not proof: a merged PR, a status in a tracking tool, a PR description. An empty commit or a PR titled "Blocked:" never counts.

## Everything missing

Change nothing. Make one empty commit `Blocked: <what is missing>` and open the PR with `"outcome":"blocked"` in the gilde-result block. Name the missing artifact and the job or PR it should come from. Never reimplement the prerequisite, stub it, or guess its contract.

## Partly there

Build only on what exists. In the PR, list exactly which artifacts you relied on and which are missing. If the missing part is needed for your acceptance criteria, report `partial` or `blocked` instead of filling the gap.

## Recovering an old or closed branch

1. Rebase it on `origin/main`; resolve conflicts in favour of main's newer behaviour.
2. Diff every function you rewrote against main's version (`git diff origin/main -- <path>`) to catch behaviour that was silently dropped.
3. List the recovered commits in the PR description.
