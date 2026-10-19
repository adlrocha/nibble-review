export default {
  concurrency: 1,
  // This is a safety guard, not the performance target. Reviews are measured
  // against targetDurationMs without killing useful output at that boundary.
  targetDurationMs: 600_000,
  // Hard stuck-provider ceiling; targetDurationMs above remains advisory.
  reviewTimeoutMs: 1_800_000,
  keepScratch: false,
  // Model comparisons remain opt-in CLI runs so the committed matrix stays
  // a small, predictable low-cost baseline.
  models: ["opencode-go/deepseek-v4.1-flash"],
  input: [
    {
      pr: "https://github.com/vercel/next.js/pull/31936",
      ignoreHistory: true,
      label: "beforeInteractive streaming",
    },
    {
      pr: "https://github.com/TanStack/query/pull/7988",
      ignoreHistory: true,
      label: "React use promise support",
    },
    {
      pr: "https://github.com/trpc/trpc/pull/7262",
      ignoreHistory: true,
      label: "batch stream call index",
    },
  ],
  judge: {
    model: "opencode-go/deepseek-v4.1-flash",
    timeoutMs: 120_000,
  },
}
