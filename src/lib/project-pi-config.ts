import { existsSync, renameSync } from "node:fs"
import { join } from "node:path"

/** pi reads settings from here and auto-installs any packages they list at startup. */
export const PROJECT_PI_DIRECTORY = ".pi"

/** Where the reviewed repository's pi directory waits while a review runs. */
export const QUARANTINED_PI_DIRECTORY = ".pi.nibble-review-quarantine"

/**
 * Moves the reviewed repository's `.pi` directory out of pi's reach for one
 * review and returns the function that restores it. A pull request can add
 * `.pi/settings.json` packages, which pi would otherwise install and execute
 * with the reviewer's model credentials.
 *
 * @example
 * const restore = quarantineProjectPiConfig(workspace)
 * try { await review() } finally { restore() }
 */
export function quarantineProjectPiConfig(workspace: string): () => void {
  const original = join(workspace, PROJECT_PI_DIRECTORY)
  const quarantined = join(workspace, QUARANTINED_PI_DIRECTORY)
  if (existsSync(quarantined)) {
    throw new Error(
      `${quarantined} already exists; a previous review did not restore it. Move it back to ${original} and retry.`
    )
  }
  if (!existsSync(original)) {
    return () => {}
  }
  renameSync(original, quarantined)
  let restored = false
  return () => {
    if (restored) {
      return
    }
    restored = true
    renameSync(quarantined, original)
  }
}
