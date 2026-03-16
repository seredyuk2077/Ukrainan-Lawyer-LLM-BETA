# Repo Guidance

## Use This Skill First

- Use `lexery-legal-agent-workflow` when tasks mention `scripts/lexery-legal-agent`, `docs/architecture/app`, `supabase/migrations`, U-stage names, retrieval/gate logic, memory manager, run triage, or architecture/status docs.
- If the best supporting skill is not obvious, use `skill-dispatch-router` to choose the smallest relevant installed skill.
- If the task is about skills themselves, trust, installation, or safety, use `skill-safety-audit`.
- Then combine it with the smallest specialized skill that fits:
- `doc` for ADRs, architecture docs, cleanup plans, run reports, and README work.
- `linear` for issue-driven work, attached product context, and project/cycle status.
- built-in Playwright/browser tools first for frontend and browser-based validation; use the installed `playwright` skill only as a manual reference, not as an auto-run wrapper.
- `pdf` for PDF/attachment/document-layout work.
- `security-best-practices` for auth, storage, isolation, secrets, and input-validation review.
- `gh-fix-ci` for GitHub Actions or PR-check repair during stabilization/cleanup.
- `openai-docs` for up-to-date OpenAI API/model guidance.

## Skill Trust

- Auto-prefer only the trusted local skills and treat external/system-integrated skills as conditional-use.
- Never install a new skill straight into `~/.codex/skills`; stage and audit it first.
- If a skill conflicts with repository code, tests, migrations, or config, the repository wins.

## Current Focus

- Active work is concentrated in `scripts/lexery-legal-agent/`, `docs/architecture/app/u9`, `u10`, `u11`, `u12`, `mm`, `context`, and `supabase/migrations/`.
- Program phase: finish the pipeline and bring MM memory close to ideal first; postpone major repo cleanup/refactors until after that.
- Expect a dirty worktree. Never revert user changes unless explicitly asked.
- Another Codex chat may be working on `docs/architecture/app/mm/`; avoid editing MM docs here unless explicitly requested in this thread.

## Start Every Task

- Run `git status --short --branch`.
- Map the task to the nearest area: U1 gateway, U2 classify, U3 plan, U4/U5 retrieval/gate, U9 assemble, U10 write, U11 verify, U12 deliver, or MM memory.
- Read the matching README and `pipeline.md` before editing.
- Treat code, tests, migrations, and config as the source of truth; use docs and skills to accelerate, not to override repository evidence.

## Verification Defaults

- U9: `pnpm brain:test:u9-units`
- U10: `pnpm brain:test:u10-units`
- U10 preview/prompt UX: `pnpm brain:test:u10-preview-units`
- U10 memory path: `pnpm brain:test:u10-memory-search-units`
- U11: `pnpm brain:test:u11-units`
- U12: `pnpm brain:test:u12-units`
- Retrieval/gate handoff: `pnpm brain:verify:u5`
- Broader retrieval changes: `pnpm brain:verify:smoke`, `pnpm brain:verify:retrieval-real-dev:fast`, `pnpm brain:verify:act-type-audit:fast`
- MM: `pnpm brain:mm:smoke`, `pnpm brain:test:mm-units`, `pnpm brain:concurrency:smoke`

## Key Docs

- `scripts/lexery-legal-agent/README.md`
- `scripts/lexery-legal-agent/tools/index.md`
- `docs/architecture/app/README.md`
- `docs/architecture/app/u9/README.md`
- `docs/architecture/app/u10/README.md`
- `docs/architecture/app/u11/README.md`
- `docs/architecture/app/u12/README.md`
- `docs/architecture/app/mm/memory-pipeline.md`
- `docs/architecture/app/mm/verification.md`
