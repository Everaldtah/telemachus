/**
 * Curated frontier-model catalog + live "is it actually functional" detection.
 * For the /model menu we show only models that (a) you have a key for and (b) the
 * provider's live /models endpoint currently reports — so dead/EOL models (e.g. a
 * retired NIM model returning 410) never appear.
 */
import type { Config } from "./config";
import { createProvider } from "./providers";

export interface CatalogModel {
  ref: string; // "nvidia:..." | "openrouter:..."
  label: string; // short display label
}

/** Hand-picked strong coding/reasoning frontier models, by provider. */
export const CANDIDATES: CatalogModel[] = [
  // NVIDIA NIM
  { ref: "nvidia:moonshotai/kimi-k2.6", label: "kimi-k2.6 (nvidia)" },
  { ref: "nvidia/nemotron-3-ultra-550b-a55b", label: "nemotron-3-ultra (nvidia)" },
  { ref: "nvidia:meta/llama-3.3-70b-instruct", label: "llama-3.3-70b (nvidia)" },
  { ref: "nvidia:qwen/qwen3-coder-480b-a35b-instruct", label: "qwen3-coder-480b (nvidia)" },
  { ref: "nvidia:deepseek-ai/deepseek-v4-pro", label: "deepseek-v4-pro (nvidia)" },
  // OpenRouter
  { ref: "openrouter:moonshotai/kimi-k2", label: "kimi-k2 (openrouter)" },
  { ref: "openrouter:deepseek/deepseek-chat", label: "deepseek-chat (openrouter)" },
  { ref: "openrouter:qwen/qwen-2.5-coder-32b-instruct", label: "qwen2.5-coder-32b (openrouter)" },
  { ref: "openrouter:anthropic/claude-3.7-sonnet", label: "claude-3.7-sonnet (openrouter)" },
  { ref: "openrouter:google/gemini-2.5-flash", label: "gemini-2.5-flash (openrouter)" },
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
