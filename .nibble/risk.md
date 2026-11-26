# Risk map

What merging to `main` sets off here, and what can't be undone. `nibble land` gives this to its judge. It is context, not rules: the rules are in `sdlc.toml`.

- Merging to `main` reaches no one by itself. Repositories pin the action by commit or follow the `v1` tag, and a person moves `v1` after publishing a release. A revert before the next release undoes a merge completely.
- Once released, this action runs in other repositories' CI with their `GITHUB_TOKEN` and model API keys. Credential forwarding, the pi sandbox and its network allowlist, and the checkout steps in `action.yml` decide what a reviewed pull request can reach.
- `land` (`src/lib/land.ts`, `src/cli/land.ts`) is the fixed-rule half of what `nibble land` merges in every repository that uses it. Weakening a rule there lets something merge unattended everywhere.
- Verdict records, the review marker, and reviewer authorship decide which reviews count. A change that lets a forged or stale review count is a merge-safety bug.
- The fixer (`fix/`) commits to pull requests with a token.
- Evals, benchmarks, docs and tests run nowhere but here.
