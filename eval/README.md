# Evaluating reviewer changes

The eval framework runs the production reviewer against exact pull-request revisions without publishing to GitHub. The committed corpus uses public pull requests from projects such as Next.js, TanStack Query, and tRPC; private corpora belong in the ignored `eval/config.local.ts`. We choose changes with review history we can inspect and enough variety to exercise different review paths.

The framework measures this reviewer, with this rubric, on the code we selected. It is not a foolproof benchmark or a general model leaderboard. An LLM judge produces the score. It can miss subtle errors, reward a plausible false finding, or disagree with a human reviewer. We use it as a ruler for before-and-after changes, then read the generated reviews and compare their findings with the diff and real pull-request history.

Capture, judgment, reporting, and comparison stay separate so every score can be traced back to the review, diff, model, reviewer revision, rubric, and judge that produced it.

Real runs may send private source to an external model provider and may cost money. Start with one PR, one model, and concurrency 1. Get explicit approval before sending a private corpus to a provider that has not already been approved for that run.

`eval/runs/` and `eval/cache/` are ignored. They may contain source, pull-request metadata, review text, provider telemetry, local paths, and credentials.

## How the framework works

Each matrix cell is one exact pull-request revision reviewed by one model through one reviewer revision.

| Stage | Input | Result |
| --- | --- | --- |
| Capture | Pinned PR revision, reviewer revision, model, and history mode | A production dry-run review plus its diff, context, transcript, findings, telemetry, and completion evidence |
| Judge | Captured review, transcript, diff, normalized PR context, and fixed rubric | A score and written assessment for each rubric question |
| Report | One completed capture run and its judgments | An HTML report and `summary.json` with scores, verdicts, findings, failures, time, tokens, and separate reviewer and judge costs |
| Compare | Completed summaries from one or more runs | A cross-run HTML report and JSON summary grouped by model, reasoning variant, or reviewer version |

The capture runs the same reviewer CLI (`dist/cli/review.js`) and pi isolation as the GitHub Action, but never passes `--publish`. The judge is a separate model call. Keeping those steps apart lets us inspect a weak review before deciding whether the reviewer, rubric, judge, or corpus caused the score.

## Reading the score

The judge scores 20 questions from 0 to 10. The framework averages those answers and presents the result on a 0-100 scale. The rubric covers verdict calibration, actionability, coverage, behavioral edge cases, public contracts, testing, documentation and migration surfaces, severity, hallucination control, research diligence, structure, and tone.

A corpus score is the mean across its completed pull requests. Read it alongside completion rate, material misses, false positives, finding count, review time, and reviewer cost. We treat a higher score as an improvement only when the underlying reviews contain fewer false positives and material misses and give authors better next steps.

The judge does not see the real human review thread. We inspect that history afterward to check which findings were supported, which material issues were missed, and whether the verdict was sensible. This prevents the historical answer from steering the score, but manual comparison remains part of every serious eval.

Small score changes are not proof on their own. Model output varies between attempts, the corpus reflects our work rather than every codebase, and changing the judge or rubric breaks direct comparability. Pin the corpus, keep the judge fixed, retain every attempt, and read the artifacts before claiming an improvement.

## Latest reviewer-change snapshot

This snapshot predates the switch from OpenCode to pi and was measured upstream; re-baseline before comparing pi captures against it. On 2026-08-31, the explicit `<ReviewRouter>` and ordered `<ReviewPublication>` implementation ran against the same ten pinned, history-blind private pull-request revisions as the previous leaf-first AML snapshot. Both snapshots used `opencode-go/deepseek-v4-flash` for review and judgment with the same rubric.

| Metric | Previous AML tree | Router tree | Change |
| --- | ---: | ---: | ---: |
| Completed captures | 10/10 | 10/10 | unchanged |
| Judge score | 88.0 | 87.6 | -0.4 points |
| Mean reviewer time | 3m 49s | 5m 45s | 1m 56s slower (51%) |
| Reviewer completions | 80 | 79 | one fewer |
| Reviewer tokens | 4.09M | 4.28M | 4.8% more |
| Retained comments | 30 | 38 | eight more |
| Reviewer cost per PR | $0.0088 off-peak | $0.0129 off-peak / $0.0258 peak | usage and tariff changed |

The router run completed every capture on its first attempt and recorded no hard failures. Combined audit and synthesis token volume remained effectively flat at about 333K versus 328K despite one fewer model completion, so the native upward handoff did not duplicate parent work. Most additional token volume came from the six investigative lanes.

DeepSeek V4 Flash has separate [off-peak and weekday peak prices](https://opencode.ai/docs/go/#usage-limits). The previous capture ran during off-peak pricing; the router capture ran during a peak window. The normalized $0.0129 and observed $0.0258 values apply both tariffs to the same router-run token usage and exclude judge inference. Actual cost also varies with review content, cache behavior, and future provider pricing.

The router run retained one high, 13 low, 23 nit, and one question finding. The previous snapshot retained 15 low and 15 nit findings. Manual inspection and judge feedback found stronger behavioral-edge-case, public-contract, documentation, and output-hygiene coverage, but weaker severity calibration in two reviews; the material-finding count remained nearly flat while nit volume increased.

One judgment exceeded the corpus's 180-second judge timeout. The initial failed attempt was retained, and a targeted retry with a 360-second ceiling completed the tenth judgment. The score above uses ten completed judgments; reviewer time and cost remain reviewer-only and are unaffected by that retry.

This is one directly comparable before-and-after run, not a repeated-run confidence interval. It shows that the router tree preserved aggregate quality without adding model turns, while the observed latency, lane token volume, and severity calibration should be rechecked in later prompt changes.

## Requirements

- Node.js 26 or newer;
- installed repository dependencies;
- `GH_TOKEN`, `GITHUB_TOKEN`, or an authenticated GitHub CLI with read access to every input PR;
- the model provider key pi needs, exported as `*_API_KEY` (for example `OPENCODE_API_KEY`).

Captures and judgments receive only `*_API_KEY` variables, a GitHub token, and a private `HOME`; pi never reads the host's `~/.pi` login.

## Configure a corpus

The committed [config.ts](config.ts) contains a small public example. Private and long-lived local corpora belong in `eval/config.local.ts`, which is ignored by Git.

```ts
export default {
  concurrency: 1,
  models: ["opencode-go/deepseek-v4.1-flash"],
  input: [
    {
      pr: "owner/repository/123",
      base: "full-40-character-base-sha",
      head: "full-40-character-head-sha",
      ignoreHistory: true,
      label: "short description of the change"
    }
  ],
  judge: {
    model: "opencode-go/deepseek-v4.1-flash",
    timeoutMs: 300_000
  }
}
```

`ignoreHistory: true` removes issue comments, reviews, review comments, and threads from the reviewer context. PR metadata, commits, the filtered diff, and valid comment ranges remain. Use this for a fresh-review measurement.

Always pin `base` and `head` for a benchmark. Capture fails when the live PR no longer matches either SHA, which prevents a moved PR head from silently changing the corpus.

## Start with a canary

Run one known PR through the current reviewer before spending a full corpus:

```bash
npm run eval -- \
  --no-config-input \
  --pr trpc/trpc/7262 \
  --model opencode-go/deepseek-v4.1-flash \
  --concurrency 1 \
  --out eval/runs/canary \
  --force
```

The capture runs `npm run build`, prepares the exact checkout in a scratch directory, and invokes the production reviewer CLI on it without `--publish`.

Inspect the generated review and completion evidence before starting a matrix. A canary should prove that the expected model ran, every phase completed, findings reached the typed queue, required artifacts exist, and no GitHub write occurred.

## Run a benchmark

### 1. Capture reviews

```bash
npm run eval -- \
  --config eval/config.local.ts \
  --model opencode-go/deepseek-v4.1-flash \
  --out eval/runs/current-deepseek \
  --force
```

One capture writes:

- `review.md`;
- `review_comments.json`;
- `review_stats.json`;
- `provider_completions.jsonl` with content-free ACP run, session, model, and stop-reason evidence;
- `review_transcript.md`;
- the exact filtered diff and normalized PR context supplied to the judge.

`targetDurationMs` is an advisory performance target. `reviewTimeoutMs` is a larger stuck-provider ceiling. A provider may remain silent while producing a complete result, so there is no short no-output timeout.

Use `--append` to add missing matrix cells. Use `--force` when the purpose is to measure the current reviewer rather than reuse a prior capture. Cache promotion requires a completed typed result and every canonical artifact; exit zero is insufficient.

### 2. Judge the captured reviews

```bash
npm run eval:judge -- --run eval/runs/current-deepseek
```

The judge receives the generated review, filtered diff, normalized PR context, and review telemetry. Human review history stays outside the scoring prompt.

The judge reuses the config recorded in `run.json`, including its model and timeout. Pass `--config`, `--model`, or `--timeout-ms` only for an intentional override. Every paid attempt is retained under `judge-attempts/`; the canonical judge files point at the selected result, while reports account for all retained attempts.

### 3. Render the report

```bash
npm run eval:report -- --run eval/runs/current-deepseek
```

Reports require a complete capture by default. `--allow-partial` renders diagnostics for a running or interrupted capture, but that report remains ineligible for benchmark aggregation.

### 4. Compare runs

```bash
npm run eval:benchmark -- \
  --runs eval/runs/current-deepseek \
  --runs eval/runs/current-glm \
  --compare-runs \
  --out eval/runs/model-comparison.html \
  --json eval/runs/model-comparison.json
```

`--avg` groups repeated captures by exact model and reasoning variant. Completed judged evidence ranks ahead of newer failed diagnostics.

## Compare models fairly

Run every model in a comparison from the same reviewer revision:

```bash
npm run eval -- \
  --config eval/config.local.ts \
  --model opencode-go/deepseek-v4.1-flash \
  --out eval/runs/current-deepseek \
  --force

npm run eval -- \
  --config eval/config.local.ts \
  --model opencode-go/glm-5.3-flash \
  --out eval/runs/current-glm \
  --force \
  --skip-build
```

Keep these fixed across the runs:

- base and head SHAs;
- `ignoreHistory` mode;
- reviewer identity (commit, uncommitted reviewer changes, and pi version);
- judge model, prompt, rubric, and timeout;
- concurrency unless concurrency itself is under test.

The run manifest records `reviewerId`. `--append` refuses to mix reviewer identities, and the review cache never restores a capture from another identity.

Production and capture use pi. Model comparisons remain explicit through `--model` and share the same provider boundary. Judge cost is not reported: `pi -p` prints only the final text.

## What counts as a completed run

Do not accept a process exit code or a generated HTML file as proof by itself. Before quoting a score, verify:

- `run.json` marks the run complete;
- the expected number of jobs completed and none failed;
- every job has a complete typed `result.json`;
- every job has non-empty `provider_completions.jsonl` with the requested provider, model, and terminal stop reason;
- every judged job has a completed `judge.json` and retained attempt evidence;
- `summary.json` contains only completed capture and judgment results;
- the `reviewerId` in `run.json` matches the reviewer revision intended for the run.

Keep raw evidence for failed attempts. A retry can produce the selected result, but it does not erase the failed attempt's time, cost, model identity, or diagnostic value.

## Maintain the private benchmark

The ignored `eval/config.local.ts` is the local tracker for private fixed-revision corpora and known baselines. Keep it useful to the next reviewer agent:

- retain the full 40-character base and head SHAs;
- give each PR a short label that explains why it is in the corpus;
- keep old corpus arrays intact when adding a new check cohort;
- record the reviewer identity, pi version, provider model, judge model, completion count, score, time, cost, and finding count in comments;
- state whether the score predates or follows a reviewer change;
- identify the one-PR canary used before the batch;
- never move a historical pin to the PR's latest head.

When changing review behavior:

1. Read the generated review, findings, transcript, diff, and real GitHub history for each PR.
2. Classify each failure at the owner that could have prevented it: lane scope, finding text, audit calibration, deterministic validation, synthesis, judge, or missing Tool access.
3. Change prompts or code only for failure patterns demonstrated across the corpus or for one clear critical miss.
4. Run a high-signal canary that exercises the changed boundary.
5. Rerun the frozen corpus with `--force` and a new output directory.
6. Record the new result beside the old baseline instead of overwriting history.

Human history is evidence for retrospective analysis, not reviewer input. Keep it out of history-blind captures and out of the model judge. Use it afterward to measure supported findings, false positives, severity, resolved-feedback recognition, and material recall.

Do not add a skill or Tool because a reviewer mentioned it once. First prove that missing access caused the miss and that the existing filesystem, Context7, or GitHub tools could not answer the question.

## Publication boundary

Commit the eval code, rubric, public example config, documentation, and ignore rules. Keep these local:

- private repository names, PR numbers, titles, and pinned revisions;
- captures, caches, generated reports, and reviewer logs;
- generated review text and finding excerpts;
- human review exports;
- local paths, credentials, auth files, and provider tokens.

Tracked documentation may publish anonymized model-level aggregates. Label reconstructed values as reconstructed and directional. Never describe an interrupted, partially judged, or historical run as a fresh result from the current reviewer.
