/** Environment variable names whose values must never appear in published text. */
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)/u

/** Shorter values are too likely to collide with ordinary words to redact safely. */
const MINIMUM_SECRET_LENGTH = 8

export const REDACTED = "[redacted]"

/** Values such as `OPENCODE_API_KEY` name a variable (e.g. API_KEY_ENV); they are not secrets. */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u

/** Collects secret-looking environment values, longest first so overlapping values redact fully. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = Object.entries(env).flatMap(([name, value]) => {
    const trimmed = value?.trim() || ""
    return SECRET_NAME.test(name) && trimmed.length >= MINIMUM_SECRET_LENGTH && !VARIABLE_NAME.test(trimmed)
      ? [trimmed]
      : []
  })
  return [...new Set(values)].toSorted((left, right) => right.length - left.length)
}

/**
 * Replaces every occurrence of a known secret value. A prompt-injected Agent
 * could read a credential from its own process and echo it into a review, so
 * this runs on every body at the GitHub publication boundary.
 *
 * @example
 * redactSecrets("key=sk-123456789", ["sk-123456789"]) // "key=[redacted]"
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text)
}
