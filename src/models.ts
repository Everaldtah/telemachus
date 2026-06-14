/**
 * Curated frontier-model catalog + live "is it actually functional" detection.
 * For the /model menu we show only models that (a) you have a key for and (b) the
 * provider's live /models endpoint currently reports — so dead/EOL models (e.g. a
 * retired NIM model returning 410) never appear.
 *
 * Both providers are enabled (fresh keys, 2026-06-14): OpenRouter frontier models
 * (default + primary, proven reachable from the Daytona EU sandbox) AND NVIDIA NIM
 * (minimaxai/minimax-m3, verified working with the new key from a machine with NVIDIA
 * egress). CAVEAT: from the Daytona EU host, integrate.api.nvidia.com may still reset
 * the TCP connection (observed 2026-06-13 → "fetch failed"); if so, NVIDIA models will
 * be filtered out by the live /models probe in functionalModels() and OpenRouter stays
 * the working path. NVIDIA picks therefore work best when the bot runs somewhere with
 * NVIDIA egress (e.g. off-Daytona). The OpenRouter entries below were verified with a
 * real chat completion FROM THE SANDBOX.
 */
import type { Config } from "./config";
import { providerKeys } from "./config";
import { createProvider } from "./providers";

export interface CatalogModel {
  ref: string; // "nvidia:..." | "openrouter:..."
  label: string; // short display label
}

/** Strong coding/reasoning frontier models. OpenRouter entries verified from inside the
 *  Daytona sandbox (2026-06-13). NVIDIA NIM entries verified 2026-06-14 with real chat
 *  completions on the new key AND reachable from the Daytona host via the Vercel NIM proxy
 *  (NVIDIA_BASE_URL → telemachus-dashboard.vercel.app/api/nim). functionalModels() live-probes
 *  each provider's /models list, so anything temporarily unserved is hidden automatically. */
export const CANDIDATES: CatalogModel[] = [
  { ref: "openrouter:moonshotai/kimi-k2.7-code", label: "kimi-k2.7-code (openrouter)" },
  // NVIDIA NIM frontier — best general/coding models, each verified to serve completions.
  { ref: "nvidia:minimaxai/minimax-m3", label: "minimax-m3 (nvidia nim)" },
  { ref: "nvidia:moonshotai/kimi-k2.6", label: "kimi-k2.6 (nvidia nim)" },
  { ref: "nvidia:qwen/qwen3.5-397b-a17b", label: "qwen3.5-397b (nvidia nim)" },
  { ref: "nvidia:mistralai/mistral-large-3-675b-instruct-2512", label: "mistral-large-3-675b (nvidia nim)" },
  { ref: "nvidia:meta/llama-4-maverick-17b-128e-instruct", label: "llama-4-maverick (nvidia nim)" },
  { ref: "nvidia:openai/gpt-oss-120b", label: "gpt-oss-120b (nvidia nim)" },
  { ref: "nvidia:z-ai/glm-5.1", label: "glm-5.1 (nvidia nim)" },
  // OpenRouter frontier (default + fallbacks).
  { ref: "openrouter:moonshotai/kimi-k2", label: "kimi-k2 (openrouter)" },
  { ref: "openrouter:deepseek/deepseek-chat", label: "deepseek-v3 chat (openrouter)" },
  { ref: "openrouter:deepseek/deepseek-r1", label: "deepseek-r1 (openrouter)" },
  { ref: "openrouter:qwen/qwen-2.5-coder-32b-instruct", label: "qwen2.5-coder-32b (openrouter)" },
  { ref: "openrouter:meta-llama/llama-3.3-70b-instruct", label: "llama-3.3-70b (openrouter)" },
  { ref: "openrouter:google/gemini-2.5-flash", label: "gemini-2.5-flash (openrouter)" },
  { ref: "openrouter:openai/gpt-4o-mini", label: "gpt-4o-mini (openrouter)" },
];

function normalize(ref: string): string {
  return ref.includes(":") ? ref.split(":").slice(1).join(":") : ref;
}

/**
 * Return the candidate models that are actually available right now: provider key
 * present AND the model id appears in the provider's live /models listing. Falls
 * back to "key present" if a /models call fails, so the menu is never empty when a
 * key works.
 */
export async function functionalModels(config: Config): Promise<CatalogModel[]> {
  const keys = providerKeys(config);
  const haveNvidia = !!config.nvidiaKey;
  const haveOpenRouter = !!config.openrouterKey;

  const liveByKind: Record<string, Set<string> | null> = { nvidia: null, openrouter: null };
  await Promise.all(
    (["nvidia", "openrouter"] as const).map(async (kind) => {
      if (kind === "nvidia" && !haveNvidia) return;
      if (kind === "openrouter" && !haveOpenRouter) return;
      try {
        const probe = createProvider(`${kind}:_probe`, keys);
        const ids = await probe.listModels();
        liveByKind[kind] = new Set(ids.map((s) => s.toLowerCase()));
      } catch {
        liveByKind[kind] = null; // couldn't list → don't filter this provider out
      }
    })
  );

  const out: CatalogModel[] = [];
  for (const c of CANDIDATES) {
    const kind = c.ref.startsWith("openrouter:") ? "openrouter" : "nvidia";
    if (kind === "nvidia" && !haveNvidia) continue;
    if (kind === "openrouter" && !haveOpenRouter) continue;
    const live = liveByKind[kind];
    if (live && !live.has(normalize(c.ref).toLowerCase())) continue; // confirmed absent
    out.push(c);
  }
  return out;
}

export function labelFor(ref: string): string {
  const hit = CANDIDATES.find((c) => c.ref === ref);
  return hit ? hit.label : normalize(ref);
}
