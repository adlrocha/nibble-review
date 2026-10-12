import assert from "node:assert/strict"
import test from "node:test"

import { formatCost, priceUsage } from "../../eval/lib/pricing.mjs"

test("provider-reported cost remains authoritative", () => {
  const priced = priceUsage({ reportedCostUsd: 0.1234 })
  assert.equal(priced.source, "provider")
  assert.equal(priced.costUsd, 0.1234)
  assert.equal(priced.label, "$0.1234")
})

test("unreported cost stays unavailable instead of being guessed", () => {
  for (const reportedCostUsd of [null, undefined, -1, Number.NaN]) {
    const priced = priceUsage({ reportedCostUsd })
    assert.equal(priced.source, "unavailable")
    assert.equal(priced.costUsd, null)
    assert.equal(priced.label, "n/a")
  }
  assert.equal(formatCost(null), "n/a")
})
