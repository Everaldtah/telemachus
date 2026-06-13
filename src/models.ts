/**
 * Curated frontier-model catalog + live "is it actually functional" detection.
 * For the /model menu we show only models that (a) you have a key for and (b) the
 * provider's live /models endpoint currently reports — so dead/EOL models (e.g. a
 * retired NIM model returning 410) never appear.
 *
 * NOTE: when Telemachus runs in a Daytona sandbox (EU region), NVIDIA NIM
 * (integrate.api.nvidia.com) is UNREACHABLE — the egress resets the TCP connection
 * (verified 2026-06-13), causing "fetch failed". OpenRouter is reachable, so the
 * catalog and default model are OpenRouter-only. Every entry below was verified with
 * a real chat completion FROM THE SANDBOX. (NVIDIA refs still work via the provider
 * if you ever run the bot somewhere with NVIDIA egress.)
 */
import type { Config } from "./config";
import { createProvider } from "./providers";

export interface CatalogModel {
  ref: string; // "nvidia:..." | "openrouter:..."
  label: string; // short display label
}

/** Strong coding/reasoning frontier models — all verified functional via OpenRouter
 *  from inside the Daytona sandbox (2026-06-13). */
export const CANDIDATES: CatalogModel[] = [
  { ref: "openrouter:moonshotai/kimi-k2.7-code", label: "kimi-k2.7-code (openrouter)" },
  { ref: "openrouter:moonshotai/kimi-k2", label: "kimi-k2 (openrouter)" },
  { ref: "openrouter:deepseek/deepseek-chat", label: "deepseek-v3 chat (openrouter)" },
  { ref: "openrouter:deepseek/deepseek-r1", label: "deepseek-r1 (openrouter)" },
  { ref: "openrouter:qwen/qwen-2.5-coder-32b-instruct", label: "qwen2.5-coder-32b (openrouter)" },
  { ref: "openrouter:qwen/qwen-2.5-72b-instruct", label: "qwen2.5-72b (openrouter)" },
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
  const keys = { nvidia: config.nvidiaKey, openrouter: config.openrouterKey };
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
