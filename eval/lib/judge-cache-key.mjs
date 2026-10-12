import { join } from "node:path";
import { sha256File, sha256Json, sha256Text } from "./cache.mjs";
import { buildJudgePrompt } from "./judge-prompt.mjs";
import { evalJobKey } from "./job-key.mjs";

export const JUDGE_CACHE_VERSION = 5;

export function judgeCacheKey({ repoRoot, model, jobDir, job }) {
  return sha256Json({
    version: JUDGE_CACHE_VERSION,
    model,
    jobKey: evalJobKey(job),
    candidateModel: job.model,
    promptHash: sha256Text(buildJudgePrompt({ repoRoot, job })),
    contextHash: sha256File(join(jobDir, "artifacts", "review_model_context.json")),
    diffHash: sha256File(join(jobDir, "artifacts", "pr.diff")),
    queueHash: sha256File(join(jobDir, "artifacts", "review_queue.json")),
    payloadHash: sha256File(join(jobDir, "artifacts", "review_payload.json")),
    validatedHash: sha256File(join(jobDir, "artifacts", "review_validated.json")),
    validationContextHash: sha256File(join(jobDir, "artifacts", "review_validation_context.json")),
    auditContextHash: sha256File(join(jobDir, "artifacts", "audit_model_context.json")),
    reviewHash: sha256File(join(jobDir, "review.md")),
    commentsHash: sha256File(join(jobDir, "review_comments.json")),
    statsHash: sha256File(join(jobDir, "review_stats.json")),
    transcriptHash: sha256File(join(jobDir, "review_transcript.md")),
  });
}
