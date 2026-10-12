import assert from "node:assert/strict"
import test from "node:test"

import { AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { ReviewContext, ReviewOutcome, ReviewRouting, useReviewContext } from "../../dist/components/review-context.js"

function runtime() {
  return new AmlRuntime({
    agentProvider: new DeterministicAgentProvider(),
    maxConcurrentAgents: 2
  })
}

function reviewValue(id) {
  const service = { id }
  return {
    github: service,
    actions: service,
    queue: service,
    routing: new ReviewRouting(),
    outcome: new ReviewOutcome(),
    snapshot: { id },
    model: id
  }
}

function ReadRequest() {
  const review = useReviewContext()
  return JSON.stringify({
    github: review.github.id,
    model: review.model
  })
}

function ReadRouting() {
  return JSON.stringify(useReviewContext().routing.get())
}

function CompleteRouting() {
  useReviewContext().routing.complete(
    { decision: "no-review", answer: "No review needed.", source: "deterministic" },
    "No review needed.\n\n✅ LGTM"
  )
  return ""
}

function provided(value, children) {
  return jsx(ReviewContext.Provider, { value, children })
}

test("nested Context Providers preserve the flat request-scoped review context", async () => {
  const initial = reviewValue("request-1")
  const gate = { decision: "no-review", answer: "Nested route.", source: "deterministic" }
  const routing = new ReviewRouting()
  routing.complete(gate, "Nested route.\n\n✅ LGTM")
  const value = await runtime().evaluate(provided(initial, provided({ ...initial, routing }, jsx(ReadRouting, {}))))

  assert.deepEqual(JSON.parse(value), {
    gate,
    body: "Nested route.\n\n✅ LGTM"
  })
})

test("simultaneous evaluations isolate review context values", async () => {
  const [first, second] = await Promise.all([
    runtime().evaluate(provided(reviewValue("first"), jsx(ReadRequest, {}))),
    runtime().evaluate(provided(reviewValue("second"), jsx(ReadRequest, {})))
  ])

  assert.equal(JSON.parse(first).github, "first")
  assert.equal(JSON.parse(second).github, "second")
})

test("authored routers complete a route before the next Context consumer runs", async () => {
  const initial = reviewValue("request-1")
  const value = await runtime().evaluate(provided(initial, [jsx(CompleteRouting, {}), jsx(ReadRouting, {})]))

  assert.deepEqual(JSON.parse(value), {
    gate: { decision: "no-review", answer: "No review needed.", source: "deterministic" },
    body: "No review needed.\n\n✅ LGTM"
  })
})

test("ReviewRouting requires exactly one completed route", () => {
  const routing = new ReviewRouting()
  const gate = { decision: "answer", answer: "The value is retained.", source: "agent" }

  assert.throws(() => routing.get(), /has not completed/u)
  routing.complete(gate, "  The value is retained.  ")
  assert.deepEqual(routing.get(), { gate, body: "The value is retained." })
  assert.throws(() => routing.complete(gate, "Another answer."), /already complete/u)
})

test("ReviewOutcome publishes exactly once", () => {
  const outcome = new ReviewOutcome()
  const draft = {
    status: "no-review",
    gate: { decision: "no-review", answer: "Already reviewed.", source: "deterministic" },
    body: "Already reviewed.\n\n✅ LGTM"
  }

  assert.throws(() => outcome.result(), /without a publication outcome/u)

  outcome.publish(draft, null)
  assert.deepEqual(outcome.result(), { review: draft, publicationError: null })
  assert.throws(() => outcome.publish(draft, null), /already complete/u)
})
