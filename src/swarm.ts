/**
 * Telemachus coordinated agent swarm — adapted from the Qwenodyssey swarm coordinator
 * (blackboard / wave architecture). A lead model DECOMPOSES the task into
 * dependency-aware subtasks; subtasks run in topological WAVES, in parallel; each
 * subagent runs a bounded run_shell loop, executing its commands in the SHARED host
 * sandbox (this process's own machine) under its own working directory; a lead model
 * INTEGRATES the results.
 *
 * UI-agnostic: every meaningful step is emitted as a SwarmEvent via `onEvent`, so the
 * web dashboard can render one live terminal per subagent (role + $cmd + output +
 * status). Up to MAX_PANES subagents are supported.
 */
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Config } from "./config";
import type { Message, ToolSpec } from "./types";
import { createProvider } from "./providers";
import { functionalModels, labelFor } from "./models";

export const MAX_PANES = 20;

/* ─────────────────────────────── Event model ─────────────────────────────── */

export type SwarmEvent =
  | { t: number; type: "session"; session: string; task: string }
  | { t: number; type: "planning"; model: string }
  | { t: number; type: "plan"; task: string; panes: PaneInfo[]; plannedBy: string; note?: string }
  | { t: number; type: "wave"; index: number; paneIds: number[] }
  | { t: number; type: "assign"; pane: number; id: string; role: string; detail: string; model: string }
  | { t: number; type: "status"; pane: number; status: SubStatus; ms?: number; error?: string }
  | { t: number; type: "cmd"; pane: number; text: string }
  | { t: number; type: "output"; pane: number; text: string; ok?: boolean; exit?: number | null }
  | { t: number; type: "say"; pane: number; text: string }
  | { t: number; type: "synth"; model: string }
  | { t: number; type: "result"; text: string; files: string[] }
  | { t: number; type: "done"; ok: boolean; ms: number };

export interface PaneInfo {
  pane: number;
  id: string;
  role: string;
  detail: string;
  model: string;
  dependsOn: string[];
}

export type SubStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type OnEvent = (ev: SwarmEvent) => void;

interface Subtask {
  id: string;
  role: string;
  detail: string;
  dependsOn: string[];
}

/* ───────────────────────────── System prompts ────────────────────────────── */

const STANDARDS =
  "Standards: deliver COMPLETE, production-grade work with edge cases and error handling — no stubs, TODOs, or " +
  "placeholders. Be the BEST solution, not merely plausible. Ground every decision in what you actually observe " +
  "(read files, check versions) — never guess. VERIFY by actually running the program/tests before claiming done.";

const PLANNER_SYSTEM =
  "You are the LEAD PLANNER of a team of expert AI engineers working in parallel inside a shared Linux sandbox. " +
  "Break the task into a set of concrete, separable subtasks whose UNION fully covers it with NO gaps. Each " +
  "subtask names a clear, verifiable deliverable and a short ROLE (e.g. 'Backend API', 'Database schema', " +
  "'Tests'). Split along natural seams so subtasks run in parallel; use dependsOn ONLY when one genuinely needs " +
  "another's result. Include an integration subtask and, for buildable work, a test/verification subtask. You do " +
  "NOT solve the task — you ONLY produce the plan as strict JSON. You have no tools.";

function agentSystem(workdir: string): string {
  return (
    "You are an expert AI engineer completing ONE part of a larger task as a member of a coordinated team, inside " +
    "a shared Linux sandbox. Produce the actual, finished deliverable for YOUR subtask — real content, not a plan.\n" +
    `You have exactly ONE tool: run_shell, which runs a non-interactive shell command. Your working directory is ` +
    `${workdir} (create your files there). Use it to write files (heredocs/cat), install deps, build, and — ` +
    "critically — ACTUALLY RUN and VERIFY your work (run the program/tests) before claiming success. The sandbox " +
    "filesystem is SHARED with teammates: build on their results, don't clobber their files. Keep commands " +
    "non-interactive and non-destructive. When done, reply with a concise summary and the paths you created.\n\n" +
    STANDARDS
  );
}

const SYNTH_SYSTEM =
  "You are the LEAD INTEGRATOR. Merge the team's completed subtask results into ONE coherent, correct, COMPLETE " +
  "Markdown deliverable that fully fulfills the overall task: a short summary, the files/artifacts produced with " +
  "their paths, key code in fenced code blocks, and how to run it. Reconcile overlaps; close gaps. No stubs or " +
  "placeholders. Do not mention the team or the process. You have no tools; output only the final result.";

/* ──────────────────────────── Shell executor ─────────────────────────────── */

/** Run a command in the shared host sandbox (this machine), in `cwd`. */
function sh(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr ? (stdout ? "\n" : "") + stderr : "");
      if (err) {
        const code = typeof (err as any).code === "number" ? (err as any).code : null;
        resolve({ ok: false, exitCode: code, output: output || (err as Error).message });
      } else {
        resolve({ ok: true, exitCode: 0, output });
      }
    });
  });
}

/* ───────────────────────────── Decomposition ─────────────────────────────── */

const PLAN_SCHEMA_HINT =
  'Return ONLY JSON: {"subtasks":[{"id":"kebab-slug","role":"short role label","detail":"concrete verifiable deliverable","dependsOn":["otherId"]}]}.';

function extractJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function stripThinking(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, "")
    .replace(/<\|[a-zA-Z0-9_]+\|>/g, "")
    .trim();
}

function parsePlan(text: string, max: number): Subtask[] {
  const raw = extractJson(text);
  if (!raw) return [];
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return []; }
  const arr: any[] = Array.isArray(obj) ? obj : Array.isArray(obj?.subtasks) ? obj.subtasks : [];
  const seen = new Set<string>();
  const out: Subtask[] = [];
  for (let i = 0; i < arr.length && out.length < max; i++) {
    const s = arr[i] ?? {};
    let id = String(s.id ?? s.slug ?? `s${i + 1}`).trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!id || seen.has(id)) id = `s${i + 1}`;
    seen.add(id);
    const role = String(s.role ?? s.title ?? s.name ?? id).trim().slice(0, 40) || id;
    const detail = String(s.detail ?? s.description ?? s.task ?? role).trim();
    const dependsOn = Array.isArray(s.dependsOn ?? s.deps)
      ? (s.dependsOn ?? s.deps).map((d: unknown) => String(d).trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean)
      : [];
    if (detail) out.push({ id, role, detail, dependsOn });
  }
  const ids = new Set(out.map((s) => s.id));
  for (const s of out) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
  return out;
}

async function decompose(
  config: Config,
  leadModel: string,
  task: string,
  maxPanes: number,
  signal: AbortSignal | undefined
): Promise<{ subtasks: Subtask[]; plannedBy: string; note?: string }> {
  const target = Math.min(maxPanes, 8);
  const prompt =
    `Decompose this task for a team of expert agents working in PARALLEL in a shared Linux sandbox.\n` +
    `Aim for 3-${target} subtasks (never more than ${maxPanes}).\n\nTASK:\n${task}\n\n` +
    `Rules:\n- Split into the natural, separable parts (distinct components, layers, files, or questions).\n` +
    `- The union must FULLY cover the task. Include an integration subtask and a test/verification subtask for buildable work.\n` +
    `- Each "detail" names a CONCRETE, VERIFIABLE deliverable.\n` +
    `- Use "dependsOn" for subtasks that need another's RESULT first; prefer breadth (parallelizable, no deps).\n` +
    `- Return AT LEAST 2 subtasks unless the task is genuinely atomic.\n\n` + PLAN_SCHEMA_HINT;
  const provider = createProvider(leadModel, { nvidia: config.nvidiaKey, openrouter: config.openrouterKey });
  const messages: Message[] = [
    { role: "system", content: PLANNER_SYSTEM },
    { role: "user", content: prompt },
  ];
  try {
    const res = await provider.generate(messages, { temperature: 0.2, maxTokens: 1400, signal });
    const subtasks = parsePlan(stripThinking(res.text), maxPanes);
    if (subtasks.length) return { subtasks, plannedBy: leadModel };
  } catch (err) {
    return {
      subtasks: [{ id: "task", role: task.slice(0, 36) || "Task", detail: task, dependsOn: [] }],
      plannedBy: "(fallback)",
      note: `planning failed: ${(err as Error).message}`,
    };
  }
  return {
    subtasks: [{ id: "task", role: task.slice(0, 36) || "Task", detail: task, dependsOn: [] }],
    plannedBy: "(fallback)",
    note: "planner returned no parseable plan — running as one task",
  };
}

/* ─────────────────────────── Special tool calls ──────────────────────────── */

function parseSpecialToolCalls(text: string): { command: string }[] {
  const calls: { command: string }[] = [];
  const re = /<\|tool_call_begin\|>\s*(?:functions\.)?[A-Za-z0-9_.\-]+?(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try { const a = JSON.parse(m[1]); if (a.command) calls.push({ command: String(a.command) }); } catch { /* ignore */ }
  }
  return calls;
}

function cleanText(text: string): string {
  return stripThinking(text);
}

/* ──────────────────────────────── Blackboard ─────────────────────────────── */

interface Entry extends Subtask {
  pane: number;
  model: string;
  status: SubStatus;
  result: string;
  error?: string;
}

function digestFor(entries: Entry[], me: Entry): string {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const parts: string[] = [];
  const doneDeps = me.dependsOn.map((d) => byId.get(d)).filter((d): d is Entry => !!d && d.status === "done" && !!d.result);
  if (doneDeps.length) {
    parts.push("RESULTS FROM YOUR DEPENDENCIES (build on these — do not redo them):");
    for (const d of doneDeps) parts.push(`\n### [${d.id}] ${d.role}\n${d.result.slice(0, 1400)}`);
  }
  const others = entries.filter((e) => e.pane !== me.pane);
  if (others.length) {
    parts.push("\nTEAM PLAN (other agents — for awareness; do NOT do their work):\n" +
      others.map((e) => `- [${e.id}] ${e.role} — ${e.status}`).join("\n"));
  }
  return parts.join("\n");
}

/* ──────────────────────────────── Runner ─────────────────────────────────── */

export interface RunSwarmOptions {
  session: string;
  maxPanes?: number;
  concurrency?: number;
  signal?: AbortSignal;
  synthesize?: boolean;
}

/** Run the full coordinated swarm, emitting events for the dashboard. */
export async function runSwarm(config: Config, task: string, opts: RunSwarmOptions, onEvent: OnEvent): Promise<{ text: string; files: string[]; ok: boolean }> {
  const started = Date.now();
  const maxPanes = Math.min(opts.maxPanes ?? MAX_PANES, MAX_PANES);
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const now = () => Date.now();
  const emit = (ev: SwarmEvent) => { try { onEvent(ev); } catch { /* sink errors never break the run */ } };

  emit({ t: now(), type: "session", session: opts.session, task });

  // Roster: the reachable frontier models; the strongest (default) leads.
  const models = await functionalModels(config);
  const roster = models.length ? models.map((m) => m.ref) : [config.defaultModel];
  const leadModel = roster[0];

  emit({ t: now(), type: "planning", model: labelFor(leadModel) });
  const { subtasks, plannedBy, note } = await decompose(config, leadModel, task, maxPanes, opts.signal);

  // Root workspace for this swarm run (shared FS, per-subagent subdir).
  const root = path.join(os.homedir(), "swarm", opts.session);
  fs.mkdirSync(root, { recursive: true });

  const entries: Entry[] = subtasks.map((s, i) => ({
    ...s,
    pane: i,
    model: roster[i % roster.length],
    status: "queued",
    result: "",
  }));

  emit({
    t: now(), type: "plan", task, plannedBy: labelFor(plannedBy), note,
    panes: entries.map((e) => ({ pane: e.pane, id: e.id, role: e.role, detail: e.detail, model: labelFor(e.model), dependsOn: e.dependsOn })),
  });
  for (const e of entries) emit({ t: now(), type: "status", pane: e.pane, status: "queued" });

  // Wave scheduler: run subtasks whose deps are resolved, in batches of `concurrency`.
  const resolved = (s: SubStatus) => s === "done" || s === "failed" || s === "stopped";
  let waveIndex = 0;
  let guard = entries.length + 2;
  while (entries.some((e) => e.status === "queued") && guard-- > 0) {
    if (opts.signal?.aborted) break;
    let ready = entries.filter((e) => e.status === "queued" && e.dependsOn.every((d) => {
      const dep = entries.find((x) => x.id === d);
      return !dep || resolved(dep.status);
    }));
    if (ready.length === 0) {
      // dependency cycle / all-blocked → force the least-blocked queued one
      const stuck = entries.filter((e) => e.status === "queued")
        .sort((a, b) => unmet(entries, a) - unmet(entries, b))[0];
      if (!stuck) break;
      ready = [stuck];
    }
    emit({ t: now(), type: "wave", index: waveIndex, paneIds: ready.map((e) => e.pane) });
    for (let i = 0; i < ready.length; i += concurrency) {
      const batch = ready.slice(i, i + concurrency);
      await Promise.all(batch.map((e) => runSubagent(config, task, entries, e, root, opts.signal, emit)));
    }
    waveIndex++;
  }

  // Integrate.
  let finalText = "";
  const okResults = entries.filter((e) => e.status === "done" && e.result);
  if (opts.synthesize !== false && okResults.length) {
    emit({ t: now(), type: "synth", model: labelFor(leadModel) });
    finalText = await synthesize(config, leadModel, task, okResults, opts.signal);
  } else if (okResults.length) {
    finalText = okResults.map((e) => `### ${e.role}\n${e.result}`).join("\n\n");
  } else {
    finalText = "All subagents failed — no result to integrate.";
  }

  // Files produced anywhere under the run root.
  let files: string[] = [];
  try {
    const found = await sh(`find . -maxdepth 4 -type f -not -path '*/.*' 2>/dev/null | sort | head -80`, root, 15000);
    files = found.output.split("\n").map((s) => s.trim().replace(/^\.\//, "")).filter(Boolean);
  } catch { /* non-fatal */ }

  emit({ t: now(), type: "result", text: finalText, files });
  emit({ t: now(), type: "done", ok: okResults.length > 0, ms: Date.now() - started });
  return { text: finalText, files, ok: okResults.length > 0 };
}

function unmet(entries: Entry[], e: Entry): number {
  return e.dependsOn.filter((d) => {
    const dep = entries.find((x) => x.id === d);
    return dep && dep.status !== "done" && dep.status !== "failed" && dep.status !== "stopped";
  }).length;
}

const RUN_SHELL: ToolSpec = {
  name: "run_shell",
  description: "Run a non-interactive shell command in your working directory. Returns exit code and output.",
  parameters: { type: "object", properties: { command: { type: "string", description: "The command to run." } }, required: ["command"] },
};

async function runSubagent(
  config: Config, task: string, entries: Entry[], entry: Entry, root: string,
  signal: AbortSignal | undefined, emit: OnEvent
): Promise<void> {
  const start = Date.now();
  entry.status = "running";
  const workdir = path.join(root, entry.id);
  fs.mkdirSync(workdir, { recursive: true });

  emit({ t: Date.now(), type: "assign", pane: entry.pane, id: entry.id, role: entry.role, detail: entry.detail, model: labelFor(entry.model) });
  emit({ t: Date.now(), type: "status", pane: entry.pane, status: "running" });

  const provider = createProvider(entry.model, { nvidia: config.nvidiaKey, openrouter: config.openrouterKey });
  const context = digestFor(entries, entry);
  const prompt =
    `OVERALL TASK:\n${task}\n\nYOU ARE ONE AGENT IN A COORDINATED TEAM. Focus ONLY on your subtask.\n\n` +
    `YOUR SUBTASK [${entry.id}] ${entry.role}:\n${entry.detail}\n\n` +
    (context ? `--- SHARED CONTEXT FROM YOUR TEAM ---\n${context}\n\n` : "") +
    `Produce a focused, complete, final result for YOUR subtask. Reference teammates' results; don't repeat their work.`;
  const convo: Message[] = [
    { role: "system", content: agentSystem(workdir) },
    { role: "user", content: prompt },
  ];

  const maxSteps = Math.max(1, config.maxSteps);
  const timeoutMs = Math.max(5, config.execTimeoutS) * 1000;
  let allText = "";
  try {
    for (let step = 0; step <= maxSteps; step++) {
      if (signal?.aborted) throw new Error("__interrupted__");
      const res = await provider.generate(convo, { tools: step < maxSteps ? [RUN_SHELL] : undefined, signal });
      let toolCalls = (res.toolCalls ?? []).map((tc) => ({ id: tc.id, command: String(tc.arguments?.command ?? "") }));
      if (!toolCalls.length) {
        const special = parseSpecialToolCalls(res.text);
        if (special.length) toolCalls = special.map((s, i) => ({ id: `sp_${i}`, command: s.command }));
      }
      const clean = cleanText(res.text).trim();
      if (clean) { allText += (allText ? "\n" : "") + clean; emit({ t: Date.now(), type: "say", pane: entry.pane, text: clean }); }
      if (!toolCalls.length) break;

      convo.push({ role: "assistant", content: clean, tool_calls: res.toolCalls?.length ? res.toolCalls : toolCalls.map((t) => ({ id: t.id, name: "run_shell", arguments: { command: t.command } })) });
      for (const tc of toolCalls) {
        if (signal?.aborted) throw new Error("__interrupted__");
        const cmd = tc.command.trim();
        emit({ t: Date.now(), type: "cmd", pane: entry.pane, text: cmd || "(empty command)" });
        const r = cmd ? await sh(cmd, workdir, timeoutMs) : { ok: false, exitCode: null, output: "run_shell: 'command' is required." };
        const tail = (r.output || "").slice(-1400);
        emit({ t: Date.now(), type: "output", pane: entry.pane, text: tail, ok: r.ok, exit: r.exitCode });
        convo.push({ role: "tool", content: `exit=${r.exitCode ?? "null"} ok=${r.ok}\n${tail}`, tool_call_id: tc.id, name: "run_shell" });
      }
    }
    entry.status = "done";
    entry.result = allText.trim();
    emit({ t: Date.now(), type: "status", pane: entry.pane, status: "done", ms: Date.now() - start });
  } catch (err) {
    const msg = (err as Error).message;
    const stopped = signal?.aborted || /__interrupted__/.test(msg);
    entry.status = stopped ? "stopped" : "failed";
    entry.error = stopped ? "stopped" : msg;
    entry.result = cleanText(allText).trim();
    emit({ t: Date.now(), type: "status", pane: entry.pane, status: entry.status, ms: Date.now() - start, error: entry.error });
  }
}

async function synthesize(config: Config, leadModel: string, task: string, results: Entry[], signal: AbortSignal | undefined): Promise<string> {
  if (results.length === 1) return results[0].result;
  const blocks = results.map((r) => `### [${r.id}] ${r.role}\n${r.result}`).join("\n\n");
  const provider = createProvider(leadModel, { nvidia: config.nvidiaKey, openrouter: config.openrouterKey });
  const messages: Message[] = [
    { role: "system", content: SYNTH_SYSTEM },
    { role: "user", content: `OVERALL TASK:\n${task}\n\nA team completed these subtasks. Write ONE integrated Markdown report (summary, files+paths, key code in fenced blocks, how to run):\n\n${blocks}\n\n--- Write the integrated report below. ---` },
  ];
  try {
    const res = await provider.generate(messages, { temperature: 0.3, maxTokens: 2048, signal });
    return stripThinking(res.text).trim() || blocks;
  } catch {
    return blocks;
  }
}
