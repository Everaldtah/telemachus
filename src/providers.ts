/**
 * OpenAI-compatible providers for NVIDIA NIM and OpenRouter — the frontier brains
 * Telemachus can run. Dependency-free (global fetch). Handles the Kimi-on-NIM quirk
 * (degenerates when given a system role) by folding the system message into the
 * first user turn for kimi/* on NVIDIA.
 */
import type { GenerateOptions, GenerateResult, Message, Provider, ToolCall } from "./types";

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type ProviderKind = "nvidia" | "openrouter";

export function parseModelRef(ref: string): { kind: ProviderKind; model: string } {
  if (ref.startsWith("openrouter:")) return { kind: "openrouter", model: ref.slice("openrouter:".length) };
  if (ref.startsWith("nvidia:")) return { kind: "nvidia", model: ref.slice("nvidia:".length) };
  return { kind: "nvidia", model: ref };
}

export function isReasoningModel(model: string): boolean {
  return /(^|[-_/:.])(r1|qwq|o1|o3|thinking|reason|kimi|k2|nemotron)/i.test(model);
}

class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly kind: ProviderKind,
    readonly model: string,
    private baseUrl: string,
    private apiKey: string,
    private timeoutMs = 120_000
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.kind === "openrouter") {
      h["HTTP-Referer"] = "https://github.com/Everaldtah/telemachus";
      h["X-Title"] = "Telemachus";
    }
    return h;
  }

  /** Kimi K2.x on NVIDIA NIM degenerates with a system role → fold it into the user turn. */
  private systemRoleSupported(): boolean {
    return !(this.kind === "nvidia" && /kimi|k2/i.test(this.model));
  }

  private wireMessages(messages: Message[]): Record<string, unknown>[] {
    let prepared = messages;
    if (!this.systemRoleSupported()) {
      const sys = messages.find((m) => m.role === "system");
      if (sys) {
        const rest = messages.filter((m) => m.role !== "system");
        const i = rest.findIndex((m) => m.role === "user");
        if (i === -1) prepared = [{ role: "user", content: sys.content }, ...rest];
        else {
          prepared = rest.slice();
          prepared[i] = { ...prepared[i], content: `${sys.content}\n\n---\n\n${prepared[i].content}` };
        }
      }
    }
    return prepared.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.tool_call_id, name: m.name };
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        return {
          role: "assistant",
          content: m.content || "",
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  async generate(messages: Message[], options: GenerateOptions = {}): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.wireMessages(messages),
      temperature: options.temperature ?? (isReasoningModel(this.model) ? 0.6 : 0.3),
      max_tokens: options.maxTokens ?? 2048,
      stream: false,
    };
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const res = await this.fetchJson("/chat/completions", body, options.signal);
    const msg: any = res?.choices?.[0]?.message ?? {};
    return {
      text: msg?.content ?? "",
      toolCalls: parseToolCalls(msg?.tool_calls),
      promptTokens: res?.usage?.prompt_tokens,
      completionTokens: res?.usage?.completion_tokens,
      model: this.model,
    };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${this.kind} /models HTTP ${res.status}`);
    const json: any = await res.json();
    const data: any[] = json?.data ?? json?.models ?? [];
    return data.map((m) => m.id ?? m.name).filter(Boolean);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
      return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  private async fetchJson(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`${this.kind} HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      if (signal?.aborted) throw new Error("__interrupted__");
      if ((err as any)?.name === "AbortError") throw new Error(`${this.kind} request timed out`);
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}

function parseToolCalls(raw: any): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const fn = raw[i]?.function;
    if (!fn?.name) continue;
    let args: Record<string, any> = {};
    try {
      args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments || "{}") : fn.arguments ?? {};
    } catch {
      args = { _raw: fn.arguments };
    }
    calls.push({ id: raw[i].id || `call_${i}`, name: fn.name, arguments: args });
  }
  return calls.length ? calls : undefined;
}

export function createProvider(
  ref: string,
  keys: { nvidia: string; openrouter: string; nvidiaBaseUrl?: string }
): Provider {
  const { kind, model } = parseModelRef(ref);
  if (kind === "openrouter") {
    return new OpenAICompatibleProvider("openrouter", model, OPENROUTER_BASE, keys.openrouter);
  }
  const nvidiaBase = (keys.nvidiaBaseUrl || NVIDIA_BASE).replace(/\/+$/, "");
  return new OpenAICompatibleProvider("nvidia", model, nvidiaBase, keys.nvidia);
}
