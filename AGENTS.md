# AGENTS.md

nibble-review is an AI pull-request reviewer that runs inside a GitHub Actions job: six specialist lanes investigate a diff, an audit merges and demotes their findings, and one review is published. The review tree is authored in AML (`src/review.tsx`); TypeScript owns the GitHub snapshot, finding queue, validation, verdict, and publication. Read [`README.md`](README.md) for the full architecture and configuration.

## Boot sequence

1. Read this file.
2. Read [`README.md`](README.md) — architecture, configuration, trust boundaries, local runs.
3. Read [`PRD.md`](PRD.md) before changing review behavior, safety, or publication semantics.
4. Read `src/review.tsx` and the nearest component under `src/` before editing it; [`eval/README.md`](eval/README.md) before touching the evaluation harness.

## Code rules

- TypeScript, strict; ESM. `dist/` is build output — never hand-edit it; change `src/` and `npm run build`.
- `npm run lint` is `tsc --noEmit` plus oxlint; `npm run format:check` is oxfmt. Keep both clean.
- The model/application authority split in the README is a hard boundary: models investigate and write, the application decides what was reviewed, what may be posted, and what gets published. Don't move trust decisions into model-facing code.
- Untrusted PR content must never reach credentials, tool loading, or shell execution. Changes that weaken preflight, sandboxing, or the publish guards need explicit user sign-off.

## Delivery loop

Every change lands through this loop, agent-authored changes included:

1. One branch per change. Implement with tests; `npm run lint`, `npm run format:check`, and `npm test` pass locally before pushing.
2. Open the PR ready for review — drafts skip the review entirely.
3. Iterate with this repository's own nibble-review workflow (it dogfoods `@main`) until it LGTMs the **current head** and the `review` check is green. On a ⚠️ or ⛔ verdict, read every finding and resolve each one by fixing it or replying with evidence why it does not apply; never silently ignore one. Re-reviews trigger only on a push or an explicit `@nibble-review` comment — a reply alone never re-runs the reviewer. After a reply-only resolution, post `@nibble-review` to request the re-review, and wait for it before concluding.
4. Stop and hand off for merge. Report the verdict, CI state, and anything the user must decide. Do not merge, enable auto-merge, or push to `main`; merging is a human decision.

## Before yielding

- State only verified facts.
- Prefer the smallest correct change; follow existing patterns in the component you are editing.
- If the user asks a question, answer it first; don't refactor unprompted.
