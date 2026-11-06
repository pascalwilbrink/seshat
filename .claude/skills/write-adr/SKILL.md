---
name: write-adr
description: "Use when a change makes or reverses an architectural decision: choosing between technologies or approaches, adding a dependency or service with lasting impact, changing a data model, API contract, protocol, module boundary, security or deployment setup, or departing from an existing ADR. Records it as an Architecture Decision Record in docs/adr/. Not for routine changes, bug fixes or refactors that keep the design."
managed-by: gildeboek@f47d9c1
---

# Writing an ADR

An Architecture Decision Record captures **one decision**, why it was made, and what it costs. People and agents who come later read it to understand why the code looks the way it does, and to avoid re-arguing settled questions or quietly undoing them.

ADRs live in `docs/adr/` in the repo where the decision applies, one Markdown file per decision, listed in `docs/adr/README.md`.

## When to write one

Write an ADR in the same PR as the change when the change:

- chooses between real alternatives that would each have worked (a library, a storage engine, a protocol, sync vs. async, polling vs. push);
- adds a runtime dependency, external service or infrastructure component that is hard to remove later;
- changes a data model, a public or cross-service API contract, an event or message format, or a module or service boundary;
- changes how the system is deployed, authenticated, authorized or secured, or where secrets live;
- sets a convention every later change must follow (naming, error handling, layering);
- reverses or departs from an existing ADR.

Do **not** write one for bug fixes, refactors that keep the design, dependency bumps, test additions, styling or copy changes. When in doubt, ask: *would someone a year from now ask "why did we do it this way?"* If yes, write it.

If your task describes such a decision but leaves it open, and the choice is not obvious from the code and existing ADRs, do not guess: report the task as `blocked` and name the options.

## Before writing

1. Read `docs/adr/README.md` and every ADR whose title touches your area. An existing ADR is a constraint:
   - your change agrees with it → no new ADR needed; mention it in the PR;
   - your change departs from it and the task asks for that → write a new ADR that **supersedes** it (see below);
   - your change would depart from it and the task does not ask for that → follow the ADR, or report `blocked` if the task cannot be done within it.
2. Gather the facts: what forces the decision (requirements, limits, incidents, costs), the options you actually considered, and why the chosen one wins. Check claims about the code against the code.

## Writing it

1. **Number**: the next free four-digit number in `docs/adr/` (`0001`, `0002`, …). Never reuse or renumber.
2. **File**: `docs/adr/NNNN-short-kebab-title.md`, title in the imperative or as a noun phrase: `0007-use-postgres-with-migrations.md`.
3. **Content**: copy `template.md` (next to this file) and fill every section. Keep it short: one to two pages. Write for a reader who knows the project but was not there.
   - **Context**: the situation and forces, neutral, including what was true before. No solution yet.
   - **Decision**: what we do, in active voice ("We use …", "Every service …"). Concrete enough to check a PR against.
   - **Consequences**: what becomes easier and what becomes harder, including costs, risks and follow-up work. Honest, not a sales pitch.
   - **Alternatives considered**: each real option with the reason it lost. Leave out options nobody seriously considered.
4. **Status**: `Accepted` with today's date when the ADR ships in the same PR as the change; the PR review is the approval. Use `Proposed` only for an ADR-only PR that asks for a decision before any code is written.
5. **Index**: add a line to `docs/adr/README.md`: `| NNNN | [Title](NNNN-short-kebab-title.md) | Accepted | YYYY-MM-DD |`. If `docs/adr/` or the README does not exist yet, create the README with this header:

   ```markdown
   # Architecture Decision Records

   One file per decision; see the write-adr skill. Accepted ADRs are not edited, only superseded.

   | # | Decision | Status | Date |
   |---|----------|--------|------|
   ```

## Changing a decision

Accepted ADRs are history: never rewrite their context, decision or consequences. To change a decision, write a new ADR that explains what changed and states `Supersedes [NNNN](NNNN-....md)`, then change only the old ADR's status line to `Superseded by [MMMM](MMMM-....md)` and update both rows in the index. Fixing a typo or a broken link in an old ADR is fine.

## In the PR

Mention the ADR in the PR description (`ADR: docs/adr/NNNN-....md`) and summarize the decision in one sentence, so the reviewer reads it first.

## Checklist

- [ ] One decision per ADR; the title names it
- [ ] Context, Decision, Consequences and Alternatives are filled; no placeholders left
- [ ] Claims about the code are checked against the code
- [ ] Existing ADRs read; a departure supersedes explicitly
- [ ] Next free number, kebab-case file name, row added to `docs/adr/README.md`
- [ ] Linked from the PR description
