---
name: write-agents-md
description: Use when creating or updating a repository's AGENTS.md (the guide coding agents read first), e.g. when onboarding a new or existing repo into Gilde. Builds it from the shared templates and verifies every statement against the actual code.
managed-by: gildeboek@d1ce079
---

# Writing AGENTS.md

AGENTS.md is the first file every coding agent reads in a repo (Claude Code reads it via `CLAUDE.md` → `@AGENTS.md`; Codex reads it directly). A wrong AGENTS.md is worse than none: agents trust it. So **every concrete statement must be verified against the code**, never written from assumptions.

## Inputs

- The repo's **stack**: `nestjs`, `spring-boot`, `nextjs`, `node` or `other`. Take it from the task, otherwise detect it (`package.json` with `@nestjs/core` → nestjs; `pom.xml`/`build.gradle` with Spring Boot → spring-boot; `next` → nextjs).
- Templates next to this file:
  - `templates/_base.md` — sections every repo shares. Copy them as-is.
  - `templates/<stack>.md` — conventions for that stack. Use as a starting point and keep only what matches this repo.

## Procedure

1. **Read before writing.** Explore the repo first:
   - Root files: `package.json` / `pom.xml` / `build.gradle`, workspace files (`pnpm-workspace.yaml`, multi-module poms), lockfile, `README`, existing `AGENTS.md`/`CLAUDE.md`, `.github/workflows/`.
   - Source layout: where the app(s) live (root or `apps/*`, modules), how code is grouped (by domain, by layer).
   - Entry points and cross-cutting config: bootstrap file, global route prefix, versioning, database config, test config.
   - 2–3 representative modules, to learn the real conventions (naming, DTOs, error handling, tests).
2. **Collect facts with their source.** For each thing you intend to write, know the file that proves it. Examples: "global prefix `/api`" ← `src/main.ts`; "tests with vitest" ← `vitest.config.ts`.
3. **Build the file** in this order (see "Structure" below): base sections from `_base.md`, then repo-specific sections filled from your facts, then stack conventions that you confirmed in the code.
4. **Resolve conflicts in favour of the code.** If the stack template says X but the repo does Y, write Y. Mention notable deviations in the PR description.
5. **Mark uncertainty, don't guess.** If you can't verify something, write `TODO(verify): …` in place of a claim. A visible TODO is fine; a confident wrong statement is not.
6. **Run every command you list** (install, build, test, lint) and only include the ones that work. Note in the PR which commands you ran.
7. **Create `CLAUDE.md`** containing exactly `@AGENTS.md` if it doesn't exist.
8. **When updating an existing AGENTS.md:** keep its structure and any human-written rules; change only what is wrong or missing; never drop a rule without saying why in the PR.

## Structure

```markdown
# <Project> — agent guide
<1–3 sentences: what this repo is and does.>

## Repository layout        ← verified paths, what lives where
## Commands                 ← only commands you actually ran successfully
## Architecture / domains   ← modules or packages and their responsibility
## Routes / interfaces      ← prefixes, versioning, public APIs (if applicable)
## Conventions              ← confirmed patterns from the code + stack template
## Rules for agents         ← from templates/_base.md, plus repo-specific protected files
```

Keep it short: aim for under ~120 lines. Link to detail (skills, docs) instead of copying it. Point to synced skills by name (e.g. "Entities follow the `typeorm-snake-case-columns` skill") rather than repeating their content.

## Checklist before finishing

- [ ] Every path in "Repository layout" exists.
- [ ] Every command in "Commands" was run and works.
- [ ] Every convention is visible in at least one existing file (or the repo is empty and it comes from the stack template).
- [ ] Global settings (route prefix, versioning, DB, test runner, module system) match the actual config.
- [ ] Base sections from `templates/_base.md` are included unchanged.
- [ ] Unverified items are marked `TODO(verify)`.
- [ ] `CLAUDE.md` exists and contains `@AGENTS.md`.
- [ ] PR description lists: what was verified, commands run, deviations from the stack template, open TODOs.
