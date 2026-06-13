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
  "You have ONE tool: run_shell, which executes a shell command in the sandbox. Use it to inspect, create, " +
  "and edit files (heredocs/cat), install dependencies, run code, and run tests.\n\n" +
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

  for (let step = 0; step <= opts.maxSteps; step++) {
    if (opts.signal?.aborted) return { text: finalText, steps, files: [], stopped: true };
    steps = step + 1;
    onProgress("think", "thinking…");

    let res: GenerateResult;
    try {
      res = await provider.generate(convo, {
        tools: step < opts.maxSteps ? [RUN_SHELL] : undefined,
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
