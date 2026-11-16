import { createHmac, hkdfSync } from "node:crypto"

/** Signs a checkpoint the way LaneCheckpoints does, so tests can plant or forge files. */
export function signedCheckpoint(checkpoint, secret) {
  const key = Buffer.from(hkdfSync("sha256", secret, "nibble-review", "lane-checkpoints-v1", 32))
  const text = JSON.stringify(checkpoint)
  return JSON.stringify({ checkpoint: text, mac: createHmac("sha256", key).update(text).digest("hex") })
}
