<!-- Shared by every repo. Copy these sections into AGENTS.md unchanged. -->

## Rules for agents
- Make the smallest change that satisfies the task and its acceptance criteria.
- If the task conflicts with existing code or is ambiguous, don't guess: report it as `blocked` and explain.
- Add or update tests for behaviour you change.
- Run the test command before opening a PR; don't open a PR with failing tests unless the task is impossible (then report `blocked`).
- Do not modify `.github/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, or existing database migrations unless the task says so.
- Skills in `.claude/skills/` are synced from Gilde-dev/gildeboek; never edit them in this repo.
- Do not add dependencies unless the task needs them; mention any new one in the PR.
- Never commit secrets, tokens or `.env` files.
