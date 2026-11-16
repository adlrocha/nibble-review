import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

import { contextReferenceSignatures, type CompactPullRequestContext } from "../services/github/context-model.js"
import { REVIEW_LANE_NAMES, ReviewFindingSchema, type ReviewFinding, type ReviewLaneName } from "./review-queue.js"

/**
 * What a lane reviewed: the diff, fixed by the head and base commits, and the
 * stated contract (title, description, and the referenced issues and pull
 * requests at their last update), the same evidence the publication freshness
 * check guards.
 */
export type LaneCheckpointScope = Readonly<{ head: string; base: string; contract: string }>

/** What a finished lane handed over: its closing summary and every finding it staged. */
export type LaneCheckpoint = Readonly<{ summary: string; findings: ReviewFinding[] }>

const CHECKPOINT_VERSION = 1
const SHA = z.string().regex(/^[0-9a-f]{40}$/u)
/** A lane's checkpoint, or a temporary file left by an interrupted write. */
const OWN_FILE = new RegExp(`^(?:${REVIEW_LANE_NAMES.join("|")})\\.json(?:\\.\\d+\\.tmp)?$`, "u")

const CheckpointSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    head: SHA,
    base: SHA,
    contract: z.string().regex(/^[0-9a-f]{64}$/u),
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
 * attempt that times out hands its finished lanes to the fallback attempt
 * instead of discarding them. The action keeps them in a temporary directory
 * of the review step only; nothing carries them to another run.
 *
 * Checkpoint files are also signed with a key derived from a secret only the
 * review holds (the model provider key), so a file it did not write is never
 * taken for a lane's work.
 *
 * A checkpoint only counts for the exact head, base and contract hash (title,
 * description, and referenced issues and pull requests) it was written for, and
 * it ignores the model. A file that is missing, unsigned, malformed or for
 * another scope is a miss, so the lane simply runs again. Writes never fail the review.
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
    if (
      parsed.lane !== lane ||
      parsed.head !== scope.head ||
      parsed.base !== scope.base ||
      parsed.contract !== scope.contract
    ) {
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
      contract: scope.contract,
      lane,
      summary: checkpoint.summary,
      findings: checkpoint.findings
    })
    if (!parsed.success) {
      return
    }
    const text = JSON.stringify(parsed.data)
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
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
   * Drops every stored lane, so the next review of this head starts fresh.
   * Only this class's own files are removed, so a shared directory keeps
   * everything else.
   */
  clear(): void {
    try {
      for (const entry of readdirSync(this.#directory)) {
        if (OWN_FILE.test(entry)) {
          rmSync(join(this.#directory, entry), { force: true })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return
      }
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

/** The revision and contract a review covers, or null when GitHub did not report both commits. */
export function laneCheckpointScope(
  context: Pick<
    CompactPullRequestContext,
    "headRefOid" | "baseRefOid" | "title" | "description" | "issues" | "pullRequests"
  >
): LaneCheckpointScope | null {
  const head = SHA.safeParse(context.headRefOid)
  const base = SHA.safeParse(context.baseRefOid)
  if (!head.success || !base.success) {
    return null
  }
  const references = contextReferenceSignatures(context)
  const contract = createHash("sha256")
    .update(JSON.stringify({ title: context.title, description: context.description, references }))
    .digest("hex")
  return { head: head.data, base: base.data, contract }
}
