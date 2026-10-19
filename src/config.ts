/** pi model (`provider/model`) used when neither the CLI nor the environment selects one. */
export const DEFAULT_REVIEW_MODEL = "opencode-go/deepseek-v4.1-flash"

/** Matches the six specialist review lanes that AML evaluates in parallel. */
export const DEFAULT_REVIEW_CONCURRENCY = 6

/** Lets AML expose oversized policy and context files by path instead of inlining them. */
export const REVIEW_INCLUDE_MAX_BYTES = 32_768
