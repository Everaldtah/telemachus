/**
 * Self-contained model + connectivity tester. Runs anywhere with node 18+ and the
 * keys in process.env (NVIDIA_API_KEY / OPENROUTER_API_KEY). Used both locally and
 * INSIDE the host sandbox to see exactly what the bot's environment can reach.
 *
 * For each candidate it does a REAL 1-token chat completion and reports ok / HTTP
 * status / error. Also pings each provider's /models and the Daytona API.
 */
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const CANDIDATES = [
  ["nvidia", "moonshotai/kimi-k2.6"],
  ["nvidia", "nvidia/nemotron-3-ultra-550b-a55b"],
  ["nvidia", "meta/llama-3.3-70b-instruct"],
  ["nvidia", "qwen/qwen3-coder-480b-a35b-instruct"],
  ["nvidia", "deepseek-ai/deepseek-v4-pro"],
  ["openrouter", "moonshotai/kimi-k2"],
  ["openrouter", "deepseek/deepseek-chat"],
  ["openrouter", "qwen/qwen-2.5-coder-32b-instruct"],
  ["openrouter", "anthropic/claude-3.7-sonnet"],
  ["openrouter", "google/gemini-2.5-flash"],
];

const NV = process.env.NVIDIA_API_KEY || "";
const OR = process.env.OPENROUTER_API_KEY || "";

function base(kind) { return kind === "openrouter" ? OPENROUTER_BASE : NVIDIA_BASE; }
function headers(kind) {
  const key = kind === "openrouter" ? OR : NV;
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  if (kind === "openrouter") { h["HTTP-Referer"] = "https://github.com/Everaldtah/telemachus"; h["X-Title"] = "Telemachus"; }
  return h;
}

async function timed(fn) {
  const t = Date.now();
  try { const v = await fn(); return { ms: Date.now() - t, ...v }; }
  catch (e) { return { ms: Date.now() - t, ok: false, err: e.name + ": " + e.message + (e.cause ? " | cause: " + (e.cause.code || e.cause.message) : "") }; }
}

async function ping(kind) {
  return timed(async () => {
    const res = await fetch(`${base(kind)}/models`, { headers: headers(kind) });
    let n = 0; try { const j = await res.json(); n = (j.data || j.models || []).length; } catch {}
    return { ok: res.ok, status: res.status, count: n };
  });
}

async function chat(kind, model) {
  return timed(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(`${base(kind)}/chat/completions`, {
        method: "POST", headers: headers(kind), signal: ctrl.signal,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 4, temperature: 0 }),
      });
      const txt = await res.text();
      let content = ""; try { content = JSON.parse(txt)?.choices?.[0]?.message?.content ?? ""; } catch {}
      return { ok: res.ok, status: res.status, reply: res.ok ? (content || "").slice(0, 20).replace(/\n/g, " ") : txt.slice(0, 120) };
    } finally { clearTimeout(timer); }
  });
}

(async () => {
  console.log("node", process.version, "| NVIDIA key", NV ? "set" : "MISSING", "| OpenRouter key", OR ? "set" : "MISSING");

  // Daytona reachability (the bot needs this to spawn executor sandboxes).
  const dURL = process.env.DAYTONA_API_URL || "https://app.daytona.io/api";
  const d = await timed(async () => {
    const res = await fetch(`${dURL}/sandbox`, { headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY || ""}` } });
    return { ok: res.ok, status: res.status };
  });
  console.log(`daytona  ${dURL}  -> ${d.ok ? "OK" : "FAIL"} ${d.status || d.err || ""} (${d.ms}ms)`);

  for (const kind of ["nvidia", "openrouter"]) {
    const p = await ping(kind);
    console.log(`${kind} /models -> ${p.ok ? "OK" : "FAIL"} ${p.status || ""} ${p.err || ""} count=${p.count ?? "?"} (${p.ms}ms)`);
  }

  console.log("\n=== chat completion per candidate ===");
  const results = [];
  for (const [kind, model] of CANDIDATES) {
    const r = await chat(kind, model);
    const tag = r.ok ? "✅ OK " : "❌ BAD";
    console.log(`${tag} ${kind}:${model}  [${r.status || "-"}] ${r.ms}ms  ${r.ok ? "reply=" + JSON.stringify(r.reply) : (r.err || r.reply)}`);
    results.push({ ref: kind + ":" + model, ok: r.ok, status: r.status });
  }
  const good = results.filter(r => r.ok).map(r => r.ref);
  const bad = results.filter(r => !r.ok).map(r => r.ref);
  console.log("\nFUNCTIONAL (" + good.length + "): " + good.join(", "));
  console.log("DEAD (" + bad.length + "): " + bad.join(", "));
})();
