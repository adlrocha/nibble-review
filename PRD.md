# Nibble Review Product Contract

## Purpose

Nibble Review provides actionable, evidence-backed pull-request review with the consistency of a managed application and the repository awareness of a coding agent. The current repository owns the review engine, its composite GitHub Action, and the evaluation harness. Account, subscription, and repository-management surfaces are future control-plane work.

## Product goals

- Find material correctness, intent, architecture, testing, documentation, and maintainability issues without manufacturing feedback.
- Produce concise author-ready inline comments and a non-repetitive main review body.
- Keep ordinary reviews fast enough for interactive pull-request work and make contained follow-up pushes substantially cheaper.
- Run on pi in production, so any model pi supports works, while keeping the AML workflow portable to other ACP providers.
- Make the complete model workflow understandable from one declarative JSX blueprint.
- Keep side effects, validation, trust checks, and publication deterministic.

## Non-goals

- Automatic merge or approval.
- Review of fork code with repository secrets.
- A second full-PR investigation during audit or synthesis.
- Comment quotas, forced findings, or severity inflation to satisfy a score.
- File-backed handoffs between Agents.
- Provider-specific orchestration hidden behind a custom runner.

## Review contract

One accepted run freezes the pull-request head and gathers:

- PR title, body, author, refs, commits, and changed-file manifest;
- a filtered unified diff and valid GitHub comment ranges;
- issue comments, reviews, review comments, thread state, and action items;
- closing issue requirements and explicit related issue/PR descriptions and decision history, with PR enrichment bounded to one hop;
- previous bot activity needed for re-review decisions.

The application materializes pr.md, pr.diff, history.md, and issues.md for Agent evidence. The reference document contains closing issues and explicitly related issues and PRs. Everything else remains typed and request-local.

Six parallel lanes investigate distinct concerns:

1. intent and contract;
2. repository standards and architecture;
3. changed-code paths and bugs;
4. correctness risk and testing;
5. documentation and commentary;
6. maintainability and elegance.

Each lane stages final author text through add_review_comment, add_review_reply, or the exceptional add_review_blocker Tool. A concern that was not staged does not exist for downstream phases.

Audit receives the staged queue and only enough PR/history context to identify duplicates, stale feedback, and disproportionate findings. It may merge IDs, lower an anchored inline severity, or drop findings. It cannot create or re-investigate a finding, rewrite its author text, evidence, or anchor, promote severity, reclassify a question, or demote an anchorless blocker.

The deterministic ReviewQueue owns:

- changed path, line, range, and side validity;
- top-level review-reply targets;
- exact duplicate suppression;
- matching unresolved or previously posted bot feedback;
- the final GitHub payload shape.

Synthesis receives the validated findings and an application-owned verdict. It writes the short pull-request overview, optional direct answer, and optional cross-finding Recommendations. It does not repeat inline concerns.

## Verdict policy

- A retained review-level blocker or critical inline finding blocks.
- A retained high, low, or unresolved question finding requests changes.
- Replies do not determine merge readiness.
- Nit-only and empty reviews are LGTM.

`low` is a default fix-before-merge recommendation for a concrete defect, contract problem, or material structural debt that a human may override with a reason. `nit` is explicitly safe to leave unchanged.

Severity belongs to the concrete impact, not the absence of an inline anchor. The blocker Tool is reserved for a high-confidence critical issue that makes the pull request fundamentally unsafe to land and cannot honestly target one changed line.

## Follow-up and conversation behavior

The gate may answer a direct question or fast-track a no-review LGTM when the current head was already reviewed or a narrow delta clearly resolves prior feedback without introducing adjacent risk. New behavior, broad deltas, unresolved findings, explicit re-review requests, and uncertainty require the full review.

Replies to existing inline threads remain inline replies. Top-level questions or instructions may receive a short direct answer before the review summary.

## Reliability

- Any failed parallel lane fails the full review.
- An incomplete provider attempt never produces a publishable result.
- Audit failure never falls back to unaudited lane output.
- Publication verifies the current head against the reviewed head.
- Publication rechecks referenced issue timestamps and related PR timestamps and heads against the gathered context.
- Model execution starts only when the checked-out commit matches the API snapshot.
- Prepared GitHub writes are idempotent within a run.
- An ambiguous mutation outcome is recorded and never replayed.
- Dry run is the default CLI mode; live mutation requires --publish.

The workflow's 40-minute process ceiling is a stuck-provider safety boundary, not an expected review duration. Performance is measured separately in evals.

## Security

- Preflight rejects fork heads, untrusted or bot triggers, missing resources, and explicit skip directives before App-token creation and checkout.
- The workflow uses pull_request and issue_comment, never pull_request_target.
- Target dependency installation is opt-in and assumes trusted contributors.
- Agents receive a read-only filesystem, no native shell, no native network, staged-finding Tools, and focused read-only GitHub reference Tools. Snapshot reads and publication remain application-owned.

## Operations and evaluation

Production uses pi with opencode-go/deepseek-v4-flash by default and opencode-go/minimax-m3 as its fallback. pi runs with project resources disabled and an allowlisted environment. The model and maximum Agent concurrency are selected once at the runtime edge.

Every eval capture preserves the raw typed result, provider/model identity, immutable reviewer revision, exact PR revisions, judge views, timing, usage, and completion state. Exit zero alone is insufficient; required artifacts and a complete typed review must exist before judgment or cache promotion.

## Managed-service acceptance criteria

The future hosted product must add, without weakening the engine contract:

- subscription and installation ownership;
- repository selection and per-repository options;
- encrypted provider/GitHub credentials;
- durable job leases, retries, cancellation, and concurrency;
- auditable traces and result retention;
- usage accounting and plan enforcement;
- versioned Action rollout with rollback;
- a clear boundary between control-plane state and isolated review execution.
