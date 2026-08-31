import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { filterUnifiedDiff } from "./diff-filter.mjs";

const execFileAsync = promisify(execFile);

export function splitRepository(repository) {
  const [owner, repo] = String(repository || "").split("/", 2);
  if (!owner || !repo) {
    throw new Error("repository must use owner/name format");
  }
  return { owner, repo };
}

export async function resolveGitHubToken(env = process.env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) {
    return env.GH_TOKEN || env.GITHUB_TOKEN;
  }
  const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = stdout.trim();
  if (!token) {
    throw new Error("GH_TOKEN, GITHUB_TOKEN, or `gh auth token` is required");
  }
  return token;
}

export async function loadPullRequestInput(input, token) {
  const { owner, repo } = splitRepository(input.repository);
  const octokit = new Octokit({
    auth: token,
    userAgent: "nibble-review-eval",
  });

  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: input.number,
  });
  const pr = prResponse.data;
  const baseSha = String(pr.base.sha || "");
  const headSha = String(pr.head.sha || "");
  if (input.baseSha && !baseSha.toLowerCase().startsWith(input.baseSha.toLowerCase())) {
    throw new Error(`configured base SHA ${input.baseSha} does not match live PR base ${pr.base.sha}`);
  }
  if (input.headSha && !headSha.toLowerCase().startsWith(input.headSha.toLowerCase())) {
    throw new Error(`configured head SHA ${input.headSha} does not match live PR head ${pr.head.sha}`);
  }
  if (!/^[0-9a-f]{40}$/iu.test(baseSha) || !/^[0-9a-f]{40}$/iu.test(headSha)) {
    throw new Error("GitHub did not return complete base and head commit SHAs");
  }

  // Fetch review evidence only after the immutable manifest matches. This
  // avoids caching a live diff under a configured revision that already drifted.
  const [diffResponse, commits] = await Promise.all([
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: input.number,
      mediaType: { format: "diff" },
    }),
    octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
      owner,
      repo,
      pull_number: input.number,
      per_page: 100,
    }),
  ]);

  // GitHub serves PR metadata and diff through separate requests. Reject a
  // push between them instead of attaching judge evidence to the wrong head.
  const verified = (await octokit.rest.pulls.get({ owner, repo, pull_number: input.number })).data;
  if (verified.base.sha !== baseSha || verified.head.sha !== headSha) {
    throw new Error("pull request revisions changed while capturing eval evidence");
  }

  const filteredDiff = filterUnifiedDiff(String(diffResponse.data || ""));
  const context = {
    repository: input.repository,
    number: input.number,
    url: input.url,
    label: input.label,
    notes: input.notes,
    ignoreHistory: input.ignoreHistory,
    baseSha,
    headSha,
    title: pr.title || "",
    body: pr.body || "",
    author: pr.user?.login || null,
    baseRef: pr.base.ref || null,
    headRef: pr.head.ref || null,
    isDraft: Boolean(pr.draft),
    commits: commits.map((commit) => ({
      sha: commit.sha,
      message: String(commit.commit?.message || "").split(/\r?\n/u)[0],
      author: commit.author?.login || commit.commit?.author?.name || null,
    })),
    history: input.ignoreHistory
      ? {
          ignored: true,
          issueComments: [],
          reviewComments: [],
          reviews: [],
        }
      : {
          ignored: false,
          note: "The production reviewer receives history; human discussion remains outside the eval-owned judge context.",
          issueComments: [],
          reviewComments: [],
          reviews: [],
        },
    diff: {
      ignoredFiles: filteredDiff.ignoredFiles,
    },
  };

  return {
    context,
    diffText: filteredDiff.text,
    // Resolve optional short or omitted manifest revisions once. Every later
    // checkout, cache, result, and reviewer assertion uses these exact SHAs.
    input: { ...input, baseSha, headSha },
  };
}

export async function preparePullRequestWorkspace(input, workspace, token) {
  if (!/^[0-9a-f]{40}$/iu.test(input.headSha || "")) {
    throw new Error("workspace preparation requires a resolved 40-character pull-request head SHA");
  }
  const githubEnvironment = { ...process.env, GH_TOKEN: token };
  await execFileAsync("gh", ["repo", "clone", input.repository, workspace, "--", "--filter=blob:none"], {
    encoding: "utf8",
    env: githubEnvironment,
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFileAsync(
    "git",
    ["-C", workspace, "fetch", "origin", `pull/${input.number}/head:refs/remotes/eval/pr-${input.number}`],
    {
      encoding: "utf8",
      env: {
        ...githubEnvironment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  await execFileAsync("git", ["-C", workspace, "checkout", "--detach", input.headSha], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (stdout.trim() !== input.headSha) {
    throw new Error(`checked out head ${stdout.trim()} does not match requested ${input.headSha}`);
  }
}
