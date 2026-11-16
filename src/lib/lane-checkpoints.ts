import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

import { REVIEW_LANE_NAMES, ReviewFindingSchema, type ReviewFinding, type ReviewLaneName } from "./review-queue.js"

/** The pull-request revision a lane reviewed: its diff is fixed by both commits. */
export type LaneCheckpointScope = Readonly<{ head: string; base: string }>

/** What a finished lane handed over: its closing summary and every finding it staged. */
export type LaneCheckpoint = Readonly<{ summary: string; findings: ReviewFinding[] }>

const CHECKPOINT_VERSION = 1
const SHA = z.string().regex(/^[0-9a-f]{40}$/u)
const PUBLISHED_MARKER = "published.json"

const CheckpointSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    head: SHA,
    base: SHA,
    lane: z.enum(REVIEW_LANE_NAMES),
    summary: z.string().trim().min(1),
    findings: z.array(ReviewFindingSchema)
  })
  .strict()

/** The signed envelope on disk: the exact checkpoint text and its HMAC. */
const SignedFileSchema = z
  .object({
    checkpoint: z.string(),
    mac: z.string().regex(/^[0-9a-f]{64}$/u)
  })
  .strict()

/**
 * Finished specialist lanes kept on disk until a review is published, so an
 * attempt that times out hands its finished lanes to the next attempt (the
 * fallback model, or a later run that restores the directory) instead of
 * discarding them.
 *
 * Checkpoint files are signed with a key derived from a secret only the review
 * job holds (the model provider key). Anything else that can write the
 * directory or the Actions cache, such as a pull request's own CI, cannot forge
 * a lane, so restored findings carry the same authority as live ones.
 *
 * A checkpoint only counts for the exact head and base it was written for. A
 * file that is missing, unsigned, malformed or for another revision is a miss,
 * so the lane simply runs again. Writes never fail the review.
 */
export class LaneCheckpoints {
  readonly #directory: string
  readonly #key: Buffer
  readonly #progress: (line: string) => unknown
  readonly #finished = new Set<ReviewLaneName>()

  constructor(directory: string, secret: string, progress: (line: string) => unknown = () => undefined) {
    if (!secret) {
      throw new Error("lane checkpoints need a secret to sign with")
    }
    this.#directory = directory
    this.#key = Buffer.from(hkdfSync("sha256", secret, "nibble-review", "lane-checkpoints-v1", 32))
    this.#progress = progress
  }

  /** The finished lane stored for `scope`, if any. */
  load(lane: ReviewLaneName, scope: LaneCheckpointScope): LaneCheckpoint | null {
    let raw: string
    try {
      raw = readFileSync(this.#path(lane), "utf8")
    } catch {
      return null
    }
    let parsed: z.infer<typeof CheckpointSchema>
    try {
      const signed = SignedFileSchema.parse(JSON.parse(raw))
      if (!timingSafeEqual(Buffer.from(this.#mac(signed.checkpoint), "hex"), Buffer.from(signed.mac, "hex"))) {
        throw new Error("bad signature")
      }
      parsed = CheckpointSchema.parse(JSON.parse(signed.checkpoint))
    } catch {
      this.#progress(`↺ lane checkpoint ${lane}: ignored an unreadable or unsigned checkpoint`)
      return null
    }
    if (parsed.lane !== lane || parsed.head !== scope.head || parsed.base !== scope.base) {
      return null
    }
    this.#finished.add(lane)
    this.#progress(`↺ lane checkpoint ${lane}: restored ${parsed.findings.length} finding(s)`)
    return { summary: parsed.summary, findings: parsed.findings }
  }

  /** Stores a finished lane for `scope`. Failing only means running the lane again. */
  save(lane: ReviewLaneName, scope: LaneCheckpointScope, checkpoint: LaneCheckpoint): void {
    this.#finished.add(lane)
    const parsed = CheckpointSchema.safeParse({
      version: CHECKPOINT_VERSION,
      head: scope.head,
      base: scope.base,
      lane,
      summary: checkpoint.summary.trim() || "Review completed without an additional assessment.",
      findings: checkpoint.findings
    })
    if (!parsed.success) {
      return
    }
    const text = JSON.stringify(parsed.data)
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
      rmSync(join(this.#directory, PUBLISHED_MARKER), { force: true })
      const path = this.#path(lane)
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ checkpoint: text, mac: this.#mac(text) }), { mode: 0o600 })
      renameSync(temporary, path)
    } catch {
      this.#progress(`↺ lane checkpoint ${lane}: could not be saved`)
    }
  }

  /** Reports a checkpoint event, such as a restored finding that no longer applies. */
  note(line: string): void {
    this.#progress(`↺ ${line}`)
  }

  /** Whether every lane finished in this process, live or restored. */
  allFinished(): boolean {
    return REVIEW_LANE_NAMES.every(lane => this.#finished.has(lane))
  }

  /**
   * Drops every stored lane, leaving a marker so a saved copy of this
   * directory replaces older ones that still held lanes.
   */
  clear(): void {
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
      for (const entry of readdirSync(this.#directory)) {
        if (entry !== PUBLISHED_MARKER) {
          rmSync(join(this.#directory, entry), { force: true })
        }
      }
      writeFileSync(join(this.#directory, PUBLISHED_MARKER), JSON.stringify({ version: CHECKPOINT_VERSION }), {
        mode: 0o600
      })
    } catch {
      this.#progress("↺ lane checkpoints could not be cleared")
    }
  }

  #mac(text: string): string {
    return createHmac("sha256", this.#key).update(text).digest("hex")
  }

  #path(lane: ReviewLaneName): string {
    return join(this.#directory, `${lane}.json`)
  }
}

/** The revision a review covers, or null when GitHub did not report both commits. */
export function laneCheckpointScope(context: {
  headRefOid: string | null
  baseRefOid: string | null
}): LaneCheckpointScope | null {
  const head = SHA.safeParse(context.headRefOid)
  const base = SHA.safeParse(context.baseRefOid)
  return head.success && base.success ? { head: head.data, base: base.data } : null
}
