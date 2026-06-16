/**
 * Telemachus bot: bridges a Telegram chat to a single enhanced agent running in a
 * Daytona sandbox. Each chat is a session (its own sandbox + history + model). While
 * the agent works, a LIVE progress message streams its tool calls and terminal
 * output; when it finishes, the clean final result is sent as its own message.
 * Typing "/" shows the command menu; /model and /settings switch among the frontier
 * models your keys can actually reach.
 */
import type { Config } from "./config";
import { providerKeys } from "./config";
import type { Message, Provider } from "./types";
import { createProvider, parseModelRef } from "./providers";
import { DaytonaSandbox } from "./daytona";
import { functionalModels, labelFor } from "./models";
import { runAgent, SYSTEM_PROMPT } from "./agent";
import { runSwarm, type SwarmEvent } from "./swarm";
import { TelegramClient, chunkMessage, type TgUpdate, type InlineButton } from "./telegram";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface Session {
  modelRef: string;
  history: Message[];
  sandbox: DaytonaSandbox;
  busy: boolean;
  abort?: AbortController;
}

const COMMANDS = [
  { command: "start", description: "Welcome + current model" },
  { command: "help", description: "How to use Telemachus" },
  { command: "models", description: "List & switch the AI model" },
  { command: "swarm", description: "Run a multi-subagent swarm (live web dashboard)" },
  { command: "settings", description: "View settings / switch model / new session" },
  { command: "status", description: "Current model, sandbox, busy state" },
  { command: "stop", description: "Stop the agent's current task" },
  { command: "new", description: "Fresh session (new sandbox, clear history)" },
];

export class TelemachusBot {
  private sessions = new Map<number, Session>();

  constructor(private config: Config, private tg: TelegramClient) {}

  async start(): Promise<void> {
    // Best-effort identity/command registration — a transient network blip here must
    // NOT kill the bot; the poll loop below tolerates and retries network errors.
    let who = "the bot";
    try {
      const me = await this.tg.getMe();
      who = `@${me.username}`;
    } catch (err) {
      console.error("startup getMe failed (continuing):", (err as Error).message);
    }
    await this.tg.setMyCommands(COMMANDS).catch(() => {});
    console.log(`Telemachus online as ${who}. Allowed chats: ${this.config.allowedChatIds.join(", ")}`);
    let offset = 0;
    // On startup, process messages from the last 10 minutes (so a message you just
    // sent gets answered) but skip anything older, so a restart doesn't replay a
    // long backlog of stale commands.
    try {
      const backlog = await this.tg.getUpdates(0, 0);
      if (backlog.length) {
        const cutoff = Date.now() / 1000 - 600;
        const recent = backlog.find((u) => (u.message?.date ?? (u.callback_query ? cutoff : 0)) >= cutoff);
        offset = recent ? recent.update_id : backlog[backlog.length - 1].update_id + 1;
      }
    } catch {
      /* ignore — start from 0 */
    }
    for (;;) {
      let updates: TgUpdate[] = [];
      try {
        updates = await this.tg.getUpdates(offset, 50);
      } catch (err) {
        console.error("getUpdates error:", (err as Error).message);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        this.handle(u).catch((e) => console.error("handler error:", (e as Error).message));
      }
    }
  }

  private allowed(chatId: number): boolean {
    return this.config.allowedChatIds.includes(chatId);
  }

  private session(chatId: number): Session {
    let s = this.sessions.get(chatId);
    if (!s) {
      const storageNote = this.config.daytonaVolume
        ? `\n\nLarge persistent storage (S3-backed, effectively unlimited) is mounted at ${this.config.daytonaVolumeMount}. ` +
          `Put datasets, build caches, and any big or long-lived files there — it survives across sessions. The sandbox's own disk is small, so don't fill it.`
        : "";
      s = {
        modelRef: this.config.defaultModel,
        history: [{ role: "system", content: SYSTEM_PROMPT + storageNote }],
        sandbox: new DaytonaSandbox({
          apiKey: this.config.daytonaKey,
          apiUrl: this.config.daytonaUrl,
          snapshot: this.config.daytonaSnapshot,
          target: this.config.daytonaTarget,
          diskGb: this.config.daytonaDiskGb,
          volumeName: this.config.daytonaVolume,
          volumeMount: this.config.daytonaVolumeMount,
        }),
        busy: false,
      };
      this.sessions.set(chatId, s);
    }
    return s;
  }

  private provider(s: Session): Provider {
    return createProvider(s.modelRef, providerKeys(this.config));
  }

  private async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const msg = u.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    if (!this.allowed(chatId)) {
      await this.tg.sendMessage(chatId, `Not authorized. Add this chat id to TELEGRAM_ALLOWED_CHAT_IDS: ${chatId}`);
      return;
    }
    const text = msg.text.trim();
    if (text.startsWith("/")) return this.onCommand(chatId, text);
    return this.onPrompt(chatId, text);
  }

  /* ── commands ── */

  private async onCommand(chatId: number, text: string): Promise<void> {
    const [cmd] = text.slice(1).split(/\s+/);
    const s = this.session(chatId);
    switch (cmd.toLowerCase()) {
      case "start":
        await this.tg.sendMessage(
          chatId,
          `🦞 Telemachus online.\nModel: ${labelFor(s.modelRef)}\n\nJust send a coding task and I'll build it in an isolated cloud sandbox, streaming my work live. Type / for commands.`
        );
        return;
      case "help":
        await this.tg.sendMessage(
          chatId,
          "Send any task (e.g. \"build a FastAPI todo API with tests and run them\"). I work in a Daytona sandbox and stream tool calls + terminal output live, then send the final result.\n\n" +
            COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n")
        );
        return;
      case "model":
      case "models":
      case "settings":
        await this.showSettings(chatId, s);
        return;
      case "status": {
        await this.tg.sendMessage(
          chatId,
          `Model: ${labelFor(s.modelRef)} (${s.modelRef})\nSandbox: ${s.sandbox.id ?? "(not yet created)"}\nBusy: ${s.busy ? "yes" : "no"}`
        );
        return;
      }
      case "swarm": {
        const arg = text.replace(/^\/swarm(@\w+)?\s*/i, "").trim();
        if (!arg) {
          await this.tg.sendMessage(chatId, "Usage: /swarm <task>\n\nI'll split it across a team of subagents and stream each one's terminal live to your web dashboard. (You can also just say: \"use agent swarm <task>\".)");
          return;
        }
        return this.runSwarmSession(chatId, s, arg);
      }
      case "stop":
        if (s.busy && s.abort) {
          s.abort.abort();
          await this.tg.sendMessage(chatId, "🛑 Stopping the current task…");
        } else {
          await this.tg.sendMessage(chatId, "Nothing is running.");
        }
        return;
      case "new": {
        if (s.busy && s.abort) s.abort.abort();
        await s.sandbox.dispose().catch(() => {});
        this.sessions.delete(chatId);
        await this.tg.sendMessage(chatId, "✨ New session — fresh sandbox and cleared history.");
        return;
      }
      default:
        await this.tg.sendMessage(chatId, `Unknown command /${cmd}. Type / to see the menu.`);
    }
  }

  private async showSettings(chatId: number, s: Session): Promise<void> {
    const loading = await this.tg.sendMessage(chatId, "⚙️ Checking which frontier models your keys can reach…");
    const models = await functionalModels(this.config);
    if (models.length === 0) {
      await this.tg.editMessageText(chatId, loading.message_id, "No reachable models. Check NVIDIA_API_KEY / OPENROUTER_API_KEY.");
      return;
    }
    const buttons: InlineButton[][] = models.map((m) => [
      { text: `${m.ref === s.modelRef ? "✅ " : ""}${m.label}`, callback_data: `m:${m.ref}` },
    ]);
    buttons.push([{ text: "✨ New session", callback_data: "act:new" }]);
    await this.tg.editMessageText(
      chatId,
      loading.message_id,
      `⚙️ Settings\nCurrent model: ${labelFor(s.modelRef)}\n\nTap a model to switch:`,
      { buttons }
    );
  }

  private async onCallback(cq: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } }): Promise<void> {
    const chatId = cq.message?.chat.id;
    if (chatId == null || !this.allowed(chatId)) return this.tg.answerCallbackQuery(cq.id);
    const s = this.session(chatId);
    const data = cq.data ?? "";
    if (data.startsWith("m:")) {
      const ref = data.slice(2);
      // Validate the key/endpoint before committing the switch.
      const ok = await createProvider(ref, providerKeys(this.config))
        .healthCheck()
        .catch(() => ({ ok: false, detail: "unreachable" }));
      if (!ok.ok) {
        await this.tg.answerCallbackQuery(cq.id, `Can't reach that model: ${ok.detail ?? ""}`);
        return;
      }
      s.modelRef = ref;
      await this.tg.answerCallbackQuery(cq.id, `Switched to ${labelFor(ref)}`);
      if (cq.message) {
        await this.tg.editMessageText(chatId, cq.message.message_id, `✅ Model set to ${labelFor(ref)} (${ref}).`);
      }
      return;
    }
    if (data === "act:new") {
      await this.tg.answerCallbackQuery(cq.id, "New session");
      if (s.busy && s.abort) s.abort.abort();
      await s.sandbox.dispose().catch(() => {});
      this.sessions.delete(chatId);
      if (cq.message) await this.tg.editMessageText(chatId, cq.message.message_id, "✨ New session started.");
      return;
    }
    await this.tg.answerCallbackQuery(cq.id);
  }

  /* ── prompts (the live-progress run) ── */

  private async onPrompt(chatId: number, text: string): Promise<void> {
    const s = this.session(chatId);
    // Natural-language swarm trigger: "use agent swarm <task>" / "swarm: <task>".
    const swarmMatch = text.match(/^\s*(?:use\s+(?:the\s+)?agent\s+swarm|agent\s+swarm|swarm)\s*[:,-]?\s+([\s\S]+)/i);
    if (swarmMatch && swarmMatch[1].trim().length > 3) {
      return this.runSwarmSession(chatId, s, swarmMatch[1].trim());
    }
    if (s.busy) {
      await this.tg.sendMessage(chatId, "I'm still working on the previous task. Use /stop to cancel it first.");
      return;
    }
    s.busy = true;
    s.abort = new AbortController();
    s.history.push({ role: "user", content: text });

    const progress = await this.tg.sendMessage(chatId, `🦞 Working with ${labelFor(s.modelRef)} …`);
    const lines: string[] = [];
    let lastEdit = 0;
    let editing = false;
    const render = () => {
      const body = lines.join("\n");
      const tail = body.length > 3500 ? "…\n" + body.slice(-3500) : body;
      return `🦞 Working · ${labelFor(s.modelRef)}\n────────────\n${tail || "thinking…"}`;
    };
    const pushEdit = async (force = false) => {
      const now = Date.now();
      if (!force && (editing || now - lastEdit < 1800)) return;
      editing = true;
      lastEdit = now;
      await this.tg.editMessageText(chatId, progress.message_id, render()).catch(() => {});
      editing = false;
    };

    try {
      const result = await runAgent(
        this.provider(s),
        s.history,
        s.sandbox,
        {
          maxSteps: this.config.maxSteps,
          execTimeoutMs: this.config.execTimeoutS * 1000,
          signal: s.abort.signal,
          webProxyUrl: this.config.webProxyUrl,
          moltbookProxyUrl: this.config.moltbookProxyUrl,
          vision: this.config.openrouterKey
            ? { apiKey: this.config.openrouterKey, model: this.config.visionModel, baseUrl: "https://openrouter.ai/api/v1" }
            : undefined,
        },
        (kind, data) => {
          if (kind === "think") {
            this.tg.sendChatAction(chatId, "typing");
            return;
          }
          if (kind === "cmd") lines.push(`$ ${data}`);
          else if (kind === "output") lines.push(data.length > 600 ? data.slice(0, 600) + "…" : data);
          else if (kind === "text") {
            const t = data.length > 280 ? data.slice(0, 280) + "…" : data;
            lines.push(`💬 ${t}`);
          } else lines.push(data);
          if (lines.length > 200) lines.splice(0, lines.length - 200);
          void pushEdit();
        }
      );

      // Finalize the live message, then send the clean result separately.
      lines.push(result.stopped ? "🛑 stopped." : `✅ done · ${result.steps} step(s)`);
      await pushEdit(true);

      if (result.stopped && !result.text) {
        await this.tg.sendMessage(chatId, "🛑 Stopped before producing a result.");
      } else {
        const filesBlock = result.files.length
          ? `\n\n📁 Files (in sandbox ${s.sandbox.id}):\n` + result.files.map((f) => `• ${f}`).join("\n")
          : "";
        for (const chunk of chunkMessage((result.text || "(no output)") + filesBlock)) {
          await this.tg.sendMessage(chatId, chunk);
        }
      }
    } catch (err) {
      await this.tg.sendMessage(chatId, `⚠️ Error: ${(err as Error).message}`);
    } finally {
      s.busy = false;
      s.abort = undefined;
    }
  }

  /* ── agent swarm (multi-subagent, live web dashboard) ── */

  private async runSwarmSession(chatId: number, s: Session, task: string): Promise<void> {
    if (s.busy) {
      await this.tg.sendMessage(chatId, "I'm still working on the previous task. Use /stop first.");
      return;
    }
    s.busy = true;
    s.abort = new AbortController();

    // Per-session event log the dashboard reads (one JSON event per line).
    const session = `${chatId}-${Date.now().toString(36)}`;
    const dir = path.join(os.homedir(), "swarm");
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, `${session}.jsonl`);
    fs.writeFileSync(logFile, "");
    const publish = (ev: SwarmEvent) => {
      try { fs.appendFileSync(logFile, JSON.stringify(ev) + "\n"); } catch { /* ignore */ }
    };

    const link = this.config.dashboardUrl ? `${this.config.dashboardUrl}/?s=${encodeURIComponent(session)}` : "";
    await this.tg.sendMessage(
      chatId,
      `🐝 Agent swarm starting.\nTask: ${task.slice(0, 200)}\n\n` +
        (link
          ? `📺 Live dashboard (one terminal per subagent):\n${link}\n\nOpen it to watch each subagent's role, commands, and output stream in real time.`
          : "⚠️ DASHBOARD_URL is not set, so there's no web view — I'll still run the swarm and send the result here."),
      { disablePreview: true }
    );

    // Compact Telegram progress that edits in place as panes change state.
    const progress = await this.tg.sendMessage(chatId, "🐝 Planning the split…");
    const panes = new Map<number, { role: string; status: string; lastCmd?: string }>();
    let planTask = task;
    let lastEdit = 0, editing = false;
    const render = () => {
      const rows = [...panes.entries()].sort((a, b) => a[0] - b[0]).map(([p, v]) => {
        const glyph = v.status === "done" ? "✅" : v.status === "failed" ? "❌" : v.status === "running" ? "⚙️" : v.status === "stopped" ? "🛑" : "•";
        return `${glyph} ${v.role}${v.lastCmd ? `  ·  $ ${v.lastCmd.slice(0, 40)}` : ""}`;
      });
      return `🐝 Swarm · ${panes.size} subagent(s)\n────────────\n${rows.join("\n") || "planning…"}`;
    };
    const pushEdit = async (force = false) => {
      const n = Date.now();
      if (!force && (editing || n - lastEdit < 1800)) return;
      editing = true; lastEdit = n;
      await this.tg.editMessageText(chatId, progress.message_id, render()).catch(() => {});
      editing = false;
    };

    try {
      const result = await runSwarm(
        this.config,
        task,
        { session, signal: s.abort.signal },
        (ev) => {
          publish(ev);
          if (ev.type === "plan") {
            planTask = ev.task;
            for (const p of ev.panes) panes.set(p.pane, { role: p.role, status: "queued" });
          } else if (ev.type === "assign") {
            panes.set(ev.pane, { role: ev.role, status: "running" });
          } else if (ev.type === "status") {
            const v = panes.get(ev.pane); if (v) v.status = ev.status;
          } else if (ev.type === "cmd") {
            const v = panes.get(ev.pane); if (v) v.lastCmd = ev.text;
            this.tg.sendChatAction(chatId, "typing");
          }
          void pushEdit();
        }
      );
      await pushEdit(true);

      const filesBlock = result.files.length ? `\n\n📁 Files:\n` + result.files.slice(0, 40).map((f) => `• ${f}`).join("\n") : "";
      for (const chunk of chunkMessage((result.text || "(no output)") + filesBlock)) {
        await this.tg.sendMessage(chatId, chunk);
      }
      if (link) await this.tg.sendMessage(chatId, `📺 Dashboard (replay): ${link}`, { disablePreview: true });
    } catch (err) {
      await this.tg.sendMessage(chatId, `⚠️ Swarm error: ${(err as Error).message}`);
    } finally {
      s.busy = false;
      s.abort = undefined;
    }
  }
}
