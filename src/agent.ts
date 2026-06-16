/**
 * The single enhanced Telemachus agent. It runs a bounded tool loop: the model
 * thinks, calls `run_shell` (executed in the Daytona sandbox), sees the result, and
 * iterates until it produces a finished deliverable. Progress (thinking, commands,
 * output) streams live via onProgress; the final text is returned separately.
 *
 * The system prompt ADAPTS openclaw's AGENTS.md orchestration doctrine
 * (github.com/openclaw/openclaw, MIT) — complete production-grade output, best-fix
 * not plausible-fix, grounded-not-guessed, and VERIFY (actually run/test) before
 * claiming done. Design ideas only; no source copied.
 */
import type { GenerateResult, Message, Provider, ToolCall, ToolSpec } from "./types";
import type { DaytonaSandbox } from "./daytona";

export const SYSTEM_PROMPT =
  "You are Telemachus — an expert autonomous software engineer working inside an isolated Linux cloud " +
  "sandbox, reachable by your operator over Telegram. You complete the user's task end to end.\n\n" +
  "You have run_shell, which executes a shell command in the sandbox. Use it to inspect, create, " +
  "and edit files (heredocs/cat), install dependencies, run code, and run tests.\n\n" +
  "NETWORK: the sandbox has NO direct outbound internet — curl/wget to public hosts get their " +
  "connection RESET. To read a web page or call any public HTTP/HTTPS API, use the web_fetch tool " +
  "(it routes through a proxy with full internet access). Do NOT curl external URLs expecting them to " +
  "work; reach for web_fetch instead.\n\n" +
  "MOLTBOOK: you have an identity (\"telemachus\") on Moltbook, the social network for AI agents. When " +
  "asked to check/use Moltbook (or to post/comment/upvote/search there), use the moltbook tool — start " +
  "with path 'home' to see your dashboard, then engage. Your API key is injected by the proxy; never " +
  "handle or send it yourself.\n\n" +
  "Doctrine:\n" +
  "- Deliver COMPLETE, production-grade work: full implementations with edge cases, error handling, and " +
  "validation. NO stubs, NO TODOs, NO placeholders.\n" +
  "- Be the BEST solution, not merely a plausible one.\n" +
  "- Ground decisions in what you actually observe in the sandbox (read files, check versions) — never guess " +
  "APIs or state from memory; verify with a command.\n" +
  "- VERIFY before claiming success: actually run the program and/or its tests and confirm they pass.\n" +
  "- Keep commands non-interactive and non-destructive. Work under the home/project directory.\n" +
  "- When finished, reply with a concise summary of what you built, the file paths, and how to run it. The " +
  "operator sees your shell activity live, so the final message should be the clean result, not a transcript.";

export type ProgressKind = "think" | "text" | "cmd" | "output" | "info";
export type OnProgress = (kind: ProgressKind, data: string) => void;

export interface AgentResult {
  text: string;
  steps: number;
  files: string[];
  stopped: boolean;
}

const RUN_SHELL: ToolSpec = {
  name: "run_shell",
  description: "Run a non-interactive shell command in the Linux sandbox. Returns exit code and output.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The command to run." } },
    required: ["command"],
  },
};

const WEB_FETCH: ToolSpec = {
  name: "web_fetch",
  description:
    "Fetch a URL from the public internet (the sandbox itself has no direct egress; this routes " +
    "through a proxy that does). Use for reading web pages/docs and calling HTTP/HTTPS APIs. " +
    "Returns the HTTP status and the response body (text).\n" +
    "Set screenshot=true to instead RENDER the page and capture a PNG: the image is saved into the " +
    "sandbox and analyzed by a vision model — use this for visual/layout questions, charts, images, " +
    "or pages that need JavaScript. Put what you want to know in `question`.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
      method: { type: "string", description: "HTTP method (default GET). e.g. GET, POST." },
      headers: { type: "object", description: "Optional request headers as a JSON object." },
      body: { type: "string", description: "Optional request body (string) for POST/PUT/PATCH." },
      screenshot: { type: "boolean", description: "Render the page to a PNG and analyze it visually." },
      full_page: { type: "boolean", description: "For screenshots: capture the full scrollable page (default just the viewport)." },
      question: { type: "string", description: "For screenshots: what to look for / describe in the image." },
    },
    required: ["url"],
  },
};

const MOLTBOOK: ToolSpec = {
  name: "moltbook",
  description:
    "Use Moltbook — the social network for AI agents (post, comment, upvote, follow, submolts, " +
    "semantic search). Calls are authenticated automatically: your API key is injected server-side, " +
    "so NEVER include a key, token, or Authorization header. `path` is relative to the Moltbook API " +
    "(/api/v1) — e.g. 'home', 'feed?sort=hot&limit=15', 'posts', 'posts/POST_ID/comments', " +
    "'posts/POST_ID/upvote', 'search?q=...', 'verify'.\n" +
    "Routine: start with GET 'home' (your dashboard: notifications, activity, what to do next). Engage " +
    "more than you broadcast — upvote/comment beat new posts. To create a post: POST 'posts' " +
    "{submolt_name,title,content}. If a create response has verification_required, SOLVE the " +
    "math word problem in verification.challenge_text and POST 'verify' " +
    "{verification_code, answer:'<number, 2 decimals>'} to publish. Respect rate limits (1 post/30min).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Moltbook API path relative to /api/v1, e.g. 'home' or 'posts/ID/comments'." },
      method: { type: "string", description: "HTTP method (default GET): GET/POST/PATCH/DELETE." },
      body: { type: "object", description: "JSON request body for POST/PATCH (object)." },
    },
    required: ["path"],
  },
};

/** Call the Moltbook API through the key-injecting Vercel proxy. */
async function doMoltbook(
  proxyUrl: string,
  args: Record<string, any>,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number | null; text: string }> {
  const path = String(args?.path ?? "").trim().replace(/^\/+/, "").replace(/^api\/v1\/?/, "");
  if (!path) return { ok: false, status: null, text: "moltbook: 'path' is required (e.g. 'home', 'posts')." };
  const method = String(args?.method ?? "GET").toUpperCase();
  const init: RequestInit = { method, signal };
  if (args?.body != null && method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }
  try {
    const resp = await fetch(`${proxyUrl}/${path}`, init);
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (err) {
    return { ok: false, status: null, text: `moltbook failed: ${(err as Error).message}` };
  }
}

/** Perform a web fetch via the Vercel proxy (the host reaches Vercel; Vercel reaches the internet). */
async function doWebFetch(
  proxyUrl: string,
  args: Record<string, any>,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number | null; text: string }> {
  const url = String(args?.url ?? "").trim();
  if (!url) return { ok: false, status: null, text: "web_fetch: 'url' is required." };
  const method = String(args?.method ?? "GET").toUpperCase();
  const payload: Record<string, any> = { url, method };
  if (args?.headers && typeof args.headers === "object") payload.headers = args.headers;
  if (args?.body != null) payload.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  try {
    const resp = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await resp.text();
    const upstream = Number(resp.headers.get("x-proxy-status")) || resp.status;
    return { ok: resp.ok, status: upstream, text };
  } catch (err) {
    return { ok: false, status: null, text: `web_fetch failed: ${(err as Error).message}` };
  }
}

/** Derive the screenshot endpoint (…/api/shot) from the fetch-proxy URL (…/api/fetch). */
function shotEndpoint(proxyUrl: string): string {
  return /\/api\/fetch$/.test(proxyUrl) ? proxyUrl.replace(/\/api\/fetch$/, "/api/shot") : `${proxyUrl}/../shot`;
}

/**
 * Render a URL to a PNG via the Vercel screenshot endpoint, save it into the sandbox
 * (so it becomes an artifact the operator can view), then — if a vision model is
 * configured — analyze the image and return its description.
 */
async function doScreenshot(
  proxyUrl: string,
  sandbox: DaytonaSandbox,
  vision: RunAgentOptions["vision"],
  args: Record<string, any>,
  signal?: AbortSignal
): Promise<{ ok: boolean; text: string }> {
  const url = String(args?.url ?? "").trim();
  if (!url) return { ok: false, text: "web_fetch(screenshot): 'url' is required." };
  let b64: string;
  try {
    const resp = await fetch(shotEndpoint(proxyUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, full_page: !!args?.full_page }),
      signal,
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return { ok: false, text: `screenshot failed: HTTP ${resp.status} ${detail}` };
    }
    b64 = Buffer.from(await resp.arrayBuffer()).toString("base64");
  } catch (err) {
    return { ok: false, text: `screenshot failed: ${(err as Error).message}` };
  }
  if (!b64) return { ok: false, text: "screenshot failed: empty image." };

  // Persist the PNG in the sandbox (heredoc avoids command-length limits on the base64).
  const path = `/tmp/shot-${Date.now()}.png`;
  try {
    await sandbox.run(`base64 -d > ${path} <<'PNGEOF'\n${b64}\nPNGEOF`, 60000);
  } catch {
    /* non-fatal: we still have the image in memory for vision */
  }
  const sizeKb = Math.round((b64.length * 3) / 4 / 1024);
  const header = `📸 Screenshot of ${url} saved to ${path} (~${sizeKb} KB).`;

  if (!vision?.apiKey) {
    return {
      ok: true,
      text: `${header}\n(No vision model configured — set OPENROUTER_API_KEY + VISION_MODEL to auto-describe. The operator can view the saved image.)`,
    };
  }

  const prompt = String(args?.question ?? "").trim() || "Describe this web page screenshot in detail: layout, key text, and notable visual elements.";
  try {
    const resp = await fetch(`${vision.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${vision.apiKey}` },
      body: JSON.stringify({
        model: vision.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
            ],
          },
        ],
      }),
      signal,
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return { ok: true, text: `${header}\n[vision model ${vision.model} HTTP ${resp.status}: ${detail}]` };
    }
    const data: any = await resp.json();
    const desc = cleanText(String(data?.choices?.[0]?.message?.content ?? "")) || "(vision model returned no text)";
    return { ok: true, text: `${header}\n\n👁️ Vision (${vision.model}):\n${desc}` };
  } catch (err) {
    return { ok: true, text: `${header}\n[vision analysis failed: ${(err as Error).message}]` };
  }
}

/** Parse Kimi-on-NIM special-token tool calls that arrive as plain text. */
export function parseSpecialToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const re =
    /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z0-9_.\-]+?)(?::(\d+))?\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rawName = m[1];
    const name = rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".") + 1) : rawName;
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(m[3]);
    } catch {
      args = { _raw: m[3] };
    }
    calls.push({ id: `special_${m[2] ?? calls.length}`, name, arguments: args });
  }
  return calls;
}

/** Strip chain-of-thought and special control tokens from displayed/stored text. */
export function cleanText(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, "")
    .replace(/<\|[a-zA-Z0-9_]+\|>/g, "")
    .trim();
}

export interface RunAgentOptions {
  maxSteps: number;
  execTimeoutMs: number;
  signal?: AbortSignal;
  /** Vercel fetch-proxy URL. When set, the agent gets a web_fetch tool for internet access. */
  webProxyUrl?: string;
  /** Vision config for screenshot analysis (OpenRouter multimodal model). */
  vision?: { apiKey: string; model: string; baseUrl: string };
  /** Moltbook proxy URL. When set, the agent gets a moltbook tool for the AI-agent social network. */
  moltbookProxyUrl?: string;
}

/**
 * Drive the agent to completion. History is the running conversation (system +
 * prior turns + the new user message must already be appended by the caller).
 */
export async function runAgent(
  provider: Provider,
  history: Message[],
  sandbox: DaytonaSandbox,
  opts: RunAgentOptions,
  onProgress: OnProgress
): Promise<AgentResult> {
  const convo = [...history];
  let finalText = "";
  let steps = 0;
  const tools: ToolSpec[] = [RUN_SHELL];
  if (opts.webProxyUrl) tools.push(WEB_FETCH);
  if (opts.moltbookProxyUrl) tools.push(MOLTBOOK);

  for (let step = 0; step <= opts.maxSteps; step++) {
    if (opts.signal?.aborted) return { text: finalText, steps, files: [], stopped: true };
    steps = step + 1;
    onProgress("think", "thinking…");

    let res: GenerateResult;
    try {
      res = await provider.generate(convo, {
        tools: step < opts.maxSteps ? tools : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted || /__interrupted__/.test((err as Error).message)) {
        return { text: finalText, steps, files: [], stopped: true };
      }
      throw err;
    }

    let toolCalls = res.toolCalls;
    if (!toolCalls?.length) {
      const special = parseSpecialToolCalls(res.text);
      if (special.length) toolCalls = special;
    }
    const clean = cleanText(res.text);
    if (clean) {
      finalText = clean;
      onProgress("text", clean);
    }
    if (!toolCalls?.length) break;

    convo.push({ role: "assistant", content: clean, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      if (opts.signal?.aborted) return { text: finalText, steps, files: [], stopped: true };

      // ── web_fetch: internet access (text) or rendered screenshot (vision). ──
      if (tc.name === "web_fetch" && opts.webProxyUrl) {
        const a = tc.arguments ?? {};
        const shot = !!a.screenshot;
        onProgress("cmd", `web_fetch${shot ? " 📸" : ""} ${String(a.method ?? "GET").toUpperCase()} ${a.url ?? ""}`);
        let content: string;
        if (shot) {
          const s = await doScreenshot(opts.webProxyUrl, sandbox, opts.vision, a, opts.signal);
          content = s.text;
        } else {
          const w = await doWebFetch(opts.webProxyUrl, a, opts.signal);
          const body = (w.text || "").slice(0, 6000);
          content = `HTTP ${w.status ?? "?"} ok=${w.ok}\n${body}${w.text.length > 6000 ? "\n…[truncated]" : ""}`;
        }
        onProgress("output", content.length > 600 ? content.slice(0, 600) + "…" : content);
        convo.push({ role: "tool", content, tool_call_id: tc.id, name: "web_fetch" });
        continue;
      }

      // ── moltbook: the AI-agent social network (key injected by the proxy). ──
      if (tc.name === "moltbook" && opts.moltbookProxyUrl) {
        const a = tc.arguments ?? {};
        onProgress("cmd", `🦞 moltbook ${String(a.method ?? "GET").toUpperCase()} ${a.path ?? ""}`);
        const w = await doMoltbook(opts.moltbookProxyUrl, a, opts.signal);
        const body = (w.text || "").slice(0, 6000);
        const content = `HTTP ${w.status ?? "?"} ok=${w.ok}\n${body}${w.text.length > 6000 ? "\n…[truncated]" : ""}`;
        onProgress("output", content.length > 600 ? content.slice(0, 600) + "…" : content);
        convo.push({ role: "tool", content, tool_call_id: tc.id, name: "moltbook" });
        continue;
      }

      const cmd = String(tc.arguments?.command ?? "").trim();
      onProgress("cmd", cmd || "(empty command)");
      const r = cmd
        ? await sandbox.run(cmd, opts.execTimeoutMs)
        : { ok: false, exitCode: null, output: "run_shell: 'command' is required." };
      const tail = (r.output || "").slice(-1500);
      onProgress("output", `${tail}${r.ok ? "" : `\n[exit ${r.exitCode ?? "?"}]`}`);
      convo.push({
        role: "tool",
        content: `exit=${r.exitCode ?? "null"} ok=${r.ok}\n${tail}`,
        tool_call_id: tc.id,
        name: "run_shell",
      });
    }
  }

  let files: string[] = [];
  try {
    files = await sandbox.artifacts();
  } catch {
    /* non-fatal */
  }
  // Keep the running history compact: append just the final assistant turn.
  history.push({ role: "assistant", content: finalText });
  return { text: finalText, steps, files, stopped: false };
}
