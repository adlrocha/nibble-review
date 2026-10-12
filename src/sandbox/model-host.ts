import { builtinModels } from "@earendil-works/pi-ai/providers/all"

/**
 * Returns the API host a pi model talks to, from pi's own model catalog, so
 * the sandbox allowlist follows the configured model instead of a hardcoded list.
 *
 * @example
 * modelApiHost("opencode-go/deepseek-v4-flash") // "opencode.ai"
 */
export function modelApiHost(model: string): string {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`model must be provider/model, got ${JSON.stringify(model)}`)
  }
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1).replace(/:[a-z]+$/u, "")
  const entry = builtinModels().getModel(provider, id)
  if (!entry?.baseUrl) {
    throw new Error(`pi has no built-in model ${provider}/${id}; pass egress-allow explicitly`)
  }
  return new URL(entry.baseUrl).hostname.toLowerCase()
}
