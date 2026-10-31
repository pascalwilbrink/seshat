---
name: verify-library-behaviour
description: "Use when your task depends on how a third-party library behaves: a hook, an event, a protocol feature, a component, a runtime option, a default, or a licence or cloud requirement. Verify it against the installed package (version, type definitions, compiled source, a spike test) before designing or building on it. Not for code that only uses well-known, already-used APIs the same way existing code does."
managed-by: gildeboek@0b7cd9c
---

# Verifying library behaviour

Docs, READMEs, changelogs and your own memory describe some version of a library, usually not the one installed. Jobs have been planned on behaviour that did not exist in the installed version, and found out only by reading `node_modules`. Check the installed package before you design on it.

## Steps

1. **Find the installed version**, not the latest on the web.
   - Node: the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) or `node_modules/<pkg>/package.json`. In a pnpm workspace look in the app that uses the package.
   - JVM: `pom.xml`, `build.gradle(.kts)` or the resolved dependency tree, plus the managed version from the parent/BOM.
   - Note the exact `package@version`, and the versions of closely coupled packages (adapters, protocol packages).
2. **Read the package itself** for the exact API: its type definitions (`*.d.ts`, `types` in `package.json`) and, where they do not answer it, the compiled source. Look for exports, option names, events, defaults, and what happens when the feature is absent or unsupported. Also look for a licence, entitlement, API key or cloud-service requirement (a paid platform, a hosted backend, a licence check).
3. **Spike when it matters and is unclear.** If behaviour decides the design and reading did not settle it, write a small test against the real package and run it. Keep it as a test if it guards the assumption; otherwise delete it.
4. **Record what you verified**: `package@version`, file, finding. Put it in the PR (Retro or description) and, for lasting findings, in the repo's docs (README, a doc next to the code, or an ADR if it drove a decision), so the next agent does not redo it.
5. **If the library cannot do what the task assumes**, do not patch around it, fake the behaviour or guess. Report `blocked` (or `partial` if part is deliverable) with the evidence and the closest supported alternative.
6. **Do not upgrade or add a dependency** to get a feature unless the task allows it. If you do, say so in the PR, with the versions.

## Checklist

- [ ] Installed version read from the lockfile or `package.json`/`pom.xml`, not the web
- [ ] API confirmed in the package's types or source, including defaults and licence/cloud requirements
- [ ] Unclear, decisive behaviour covered by a spike test against the real package
- [ ] `package@version`, file and finding recorded in the PR (and docs if lasting)
- [ ] Unsupported assumption reported as blocked/partial with evidence, not worked around
- [ ] No unrequested upgrade or new dependency
