# Cost and token accounting

`src/model-prices.json` is the shared model-to-price map for production summaries and eval reports. Each value is `[input, output, cacheRead?, cacheWrite?]` in USD per million tokens; omitted cache rates default to zero. It stores fixed rates, with no time or context schedules. DeepSeek uses the highest published rates at all times. Add or replace a row when a model is added or tested; the Git revision identifies the snapshot.

The current snapshot was fetched from [Models.dev's API](https://models.dev/api.json) on 2026-09-11, with DeepSeek set to the highest rates in [OpenCode Go's published table](https://opencode.ai/docs/go/#usage-limits): `[0.30, 1.20, 0.006]`. Models.dev is the [catalog consumed by OpenCode](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/core/src/models-dev.ts). OpenCode's public `/zen/go/v1/models` endpoint lists model IDs but does not expose prices. These are approximate fixed values, not a claim about the Go account's actual charges or allowances.

Review costs come only from recovered database tokens: `usage.costUsd` stays null, and `usage.estimatedCostUsd` applies the map to those tokens. AML-reported costs and estimates remain diagnostic evidence in `amlUsage`, never the displayed review cost, including when database collection falls back. The summary retains `Estimated cost | n/a` when no estimate is available. Eval reports enforce the same rule, including for older ACP-only captures.

The shared `estimateCostUsd` function owns the arithmetic for database steps, diagnostic AML estimates, and eval pricing. The database override prices each step using its actual provider/model, rather than assuming every request used the configured review model. An unknown model leaves the entire estimate unavailable. OpenCode's stored `cost` is itself a catalog estimate and is not treated as provider-reported cost. Reasoning is charged at the output rate: [OpenCode normalizes output to exclude reasoning, and input to exclude caches](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/session.ts#L338). The optional ACP reasoning/cache fields are omitted when zero.

The Go API advertises `deepseek-flash`; [OpenCode maps that name to DeepSeek V4.1 Flash](https://github.com/anomalyco/opencode/blob/dev/packages/stats/core/src/domain/model-normalization.ts). Both names have explicit entries in the map with the same fixed maximum rates. Models.dev currently lists `deepseek-v4.1-flash` but omits the alias. The pinned image's bundled model catalog includes neither name; adding prices does not make them selectable through that catalog.

## Confirmed token gap

An offline reproduction on 2026-09-11 used the existing `nibble-review:eval` image (`bce18dfdcdbc`), OpenCode 1.18.18 and AML SDK 0.8.1. A local fake OpenAI-compatible endpoint returned deterministic usage for a read-tool call followed by a final response. Docker ran with `--network none`; no provider credentials or paid inference were used.

| Model request                                        | Input including cache | Output including reasoning | Total |
| ---------------------------------------------------- | --------------------: | -------------------------: | ----: |
| Title generation before the review Agent's tool loop |                 1,100 |                        100 | 1,200 |
| Agent request that calls the read tool               |                 1,100 |                        100 | 1,200 |
| Agent request after the tool result                  |                 2,200 |                        200 | 2,400 |
| All HTTP requests                                    |                 4,400 |                        400 | 4,800 |
| ACP response, copied into AML's agent-turn event     |                 2,200 |                        200 | 2,400 |

The returned ACP fields were `inputTokens: 200`, `outputTokens: 160`, `thoughtTokens: 40`, `cachedReadTokens: 2000`, `totalTokens: 2400`. They exactly match the final request, not the tool loop's 3,600 tokens or all requests' 4,800 tokens.

The source explains this: [the model loop returns its last assistant message](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/prompt.ts#L1338); [ACP passes that message to its response builder](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/acp/service.ts#L507); and [`buildUsage` reads that one message's tokens](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/acp/usage.ts#L94). AML 0.8.1 forwards `response.usage` unchanged, and this repository sums the received turn payloads. Counting all ACP turns does not count every underlying model call.

OpenCode also emits a separate `usage_update` containing cumulative session cost. In the reproduction it was $0.0012, matching both main-loop calls at the fixture's rates. That value is calculated from OpenCode's price catalog, not returned as `usage.costUsd`, and it excludes the auxiliary request. Its `used` field is context occupancy, not cumulative billed tokens; summing those updates would not repair the token count.

## Temporary database override

AML 0.8.1 closes and deletes each Agent's invocation state before that Agent's component finishes, not at the end of `evaluate()` or the script. A final sibling cannot read those original databases. `opencode-usage.sh` therefore launches the unmodified OpenCode executable with each Agent's database redirected into a private, review-owned temporary directory. All other AML state and cleanup remain unchanged; databases stay separate per Agent.

`ReviewUsageCollection` is the final deterministic sibling in the review tree, after routing, all model work, and publication. It collects stored `step-finish` parts through Node's built-in read-only SQLite connection. It does not export prompts or tool content, add duplicated message totals, sum context-occupancy updates, or query the user's global OpenCode history. If a routed evaluation fails or is cancelled before that sibling, the runner collects in `finally` after AML settles, then removes the retained directory in either case.

Results retain `amlUsage` and raw `traceSummaries` unchanged. `usageSource` is `opencode-db` when collection succeeds or `aml-acp` when it falls back. `usageNote` explains the temporary override or fallback. A missing expected session, unreadable database, or malformed counter rejects the entire override rather than mixing a partial database subtotal with ACP usage. Authored Agent turns remain AML's count; stored model steps are not additional authored turns. GitHub summaries and eval exports preserve the accounting source, and eval reports keep the per-model estimate rather than repricing mixed totals as one model.

Failed `runReview` calls attach accounting to `ReviewUnavailableError.accounting`. The separate workflow fallback still does not merge previous process attempts into the successful result; cross-attempt invoice reconciliation remains outside this override.

The database is not a complete billing ledger: requests without recorded usage cannot be recovered. Title generation is now disabled with `agent.title.disable: true` because these disposable review sessions do not need titles and OpenCode does not store that usage. Compaction remains enabled; there is no verified attribution of the remaining live-run gap to compaction. Remove the launcher and override only after a stock OpenCode release passes the multi-request reconciliation probe; see [OpenCode #41660](https://github.com/anomalyco/opencode/issues/41660). The separate AML repair-prompt summary issue is tracked in [AML #55](https://github.com/we-are-singular/aml/issues/55); no AML changes are required here.

## Offline verification

The production launcher and collector were exercised against the existing stock OpenCode 1.18.18 image, with content capture disabled and a local HTTP fixture. The final tree sibling confirmed that AML's original invocation directories had already been removed while the redirected databases remained readable. Collection and cleanup succeeded for normal continuation, an HTTP 503 retry, an HTTP 400 failure after a completed step, and two parallel Agents.

| Scenario                             | AML total tokens | Database total tokens |
| ------------------------------------ | ---------------: | --------------------: |
| Read tool followed by final response |            2,400 |                 3,600 |
| Same loop with one HTTP retry        |            2,400 |                 3,600 |
| Later request fails                  |      unavailable |                 1,200 |
| Two parallel Agents                  |            4,800 |                 7,200 |

These are deterministic fixture counters, not a measured production multiplier. Run from the repository root after `npm run build`:

```bash
for mode in normal retry failure parallel; do
  docker run --rm --network none -e FIXTURE_MODE="$mode" \
    --mount "type=bind,source=$PWD/test/fixtures/opencode-usage.mjs,target=/usr/local/lib/nibble-review/test/fixtures/opencode-usage.mjs,readonly" \
    --mount "type=bind,source=$PWD/dist,target=/usr/local/lib/nibble-review/dist,readonly" \
    --entrypoint node nibble-review:eval \
    /usr/local/lib/nibble-review/test/fixtures/opencode-usage.mjs || break
done
```

The probe now also asserts that disabling titles eliminates auxiliary HTTP requests in every scenario. `npm test` covers the production provider's title-disable configuration, database schema validation, missing sessions, independent reviews, duplicate message/step accounting, mixed-model prices, unknown prices, optional totals, cleanup, and summary/eval export behavior.

## First live reconciliation

The non-publishing AML #56 review on 2026-09-11 at 00:42–00:45 UTC ran before title generation was disabled. Go's supplied UI rows showed 44 requests, 987,641 input tokens including cache, 41,684 output tokens, and $0.0630 in displayed costs. The database captured 38 steps, 925,378 input tokens including cache, and 34,069 output tokens. AML alone reported 214,797 total tokens versus the database's 959,447 and Go's 1,029,325.

Exactly one subset of six UI rows accounts for the entire difference: 62,263 input plus 7,615 output tokens, costing $0.0139. The remaining 38 rows match the database token totals exactly. Their displayed cost is $0.0491, consistent with the database's $0.04898634 estimate at off-peak rates within per-row display rounding. The production map intentionally retains the fixed maximum rates, giving $0.09797268 for the stored steps.

The Go UI does not expose request contents, so these six requests cannot be conclusively classified as titles, compaction, or other calls from those rows alone. Title generation is disabled as an independently justified reduction in unnecessary calls, not a claim that all live accounting gaps are now resolved.

## Live run with titles disabled

A second non-publishing review of the same AML #56 base/head ran on 2026-09-11 at 01:14:21–01:17:40 UTC (02:14–02:17 Lisbon). It used the branch's compiled code with the same stock OpenCode 1.18.18 and AML SDK 0.8.1. All eight Agent completions ended with `end_turn`; publication receipts were prepared only, canonical artifacts were retained, and the container was removed.

Database collection recovered 30 model steps: 783,126 input tokens including cache and 33,836 output tokens including reasoning, totaling 816,962. AML alone reported 208,827 total tokens. The fixed maximum-rate database estimate was $0.098068488.

The user supplied 28 distinct Go rows across all eight sessions, totaling 744,881 input tokens, 32,112 output tokens, and $0.0846 in displayed costs. The `AtpNJ4YQ` row pasted twice is counted once. These supplied rows total 39,969 fewer tokens than the database: 38,245 input and 1,724 output. The UI excerpt has two fewer rows than the stored step count; their session attribution and the full bill remain unverified. This is a partial comparison, not evidence that the title-disable change closed every accounting gap.

## Comparing a real Go trace

Before a live test, agree on one model and one review target with the user. Record its start/end time, reviewed commit, provider session IDs and raw ACP usage, then compare all matching Go backoffice requests, including tool continuations, auxiliary requests, failures and retries. Use the same account and time window. The user's approximate $4/day over 20 full reviews implies $0.20/review, but it is not a measured tariff or a correction multiplier.
