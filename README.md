# Telemachus 🦞

**Your Qwenodyssey coding agent — in the cloud, on Telegram.**

Telemachus is a single, enhanced AI coding agent that runs inside an isolated
[Daytona](https://daytona.io) cloud sandbox and is driven entirely from a Telegram
chat. Send it a task from your phone; it plans, writes, runs, and **verifies** real
code in the sandbox — streaming its tool calls and terminal output back to the chat
live — then sends you the finished result. Because the work happens in the cloud, it
keeps going whether or not your computer is on.

It's a spin-off of [Qwenodyssey](https://github.com/Everaldtah/Qwenodyssey) (hence the
name — Telemachus, son of Odysseus; the *Tele-* also nods to Telegram).

---

## What it does

- **Drive it from Telegram.** Send a coding task as a normal message. Type `/` for the
  command menu.
- **Live work stream.** While the agent runs, one message updates in place with its
  **shell commands and terminal output** as they happen.
- **Clean final answer.** When it's done, the finished result (summary + key code +
  file paths + how to run) arrives as its own message.
- **Runs in the cloud.** All execution happens in a per-chat Daytona sandbox, so your
  machine is never touched and tasks survive you closing your laptop.
- **Switch models in chat.** `/model` (or `/settings`) lists the **frontier models your
  keys can actually reach** right now (NVIDIA NIM + OpenRouter) and lets you tap to
  switch — dead/retired models are filtered out automatically.
- **Built to finish the job.** The agent's doctrine (adapted, clean-room, from
  [openclaw](https://github.com/openclaw/openclaw)'s `AGENTS.md`) pushes it toward
  complete, production-grade output, grounded in what it actually observes in the
  sandbox, and verified by running the code/tests before claiming success.

---

## Quick start

```bash
git clone https://github.com/Everaldtah/telemachus
cd telemachus
npm install
npm run build
cp .env.example .env     # then fill it in (see below)
npm start
```

Requires **Node.js 18+** (uses the built-in `fetch`).

### Configure (`.env`)

| Variable | Required | What |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_ALLOWED_CHAT_IDS` | ✅ | Comma-separated numeric chat IDs allowed to use the bot. Everyone else is ignored. |
| `DAYTONA_API_KEY` | ✅ | From [app.daytona.io](https://app.daytona.io) → API keys. |
| `NVIDIA_API_KEY` | one of | NVIDIA NIM key (`integrate.api.nvidia.com`). |
| `OPENROUTER_API_KEY` | one of | OpenRouter key. |
| `TELEMACHUS_MODEL` | – | Starting model, e.g. `nvidia:moonshotai/kimi-k2.6`. Switchable in chat. |
| `TELEMACHUS_MAX_STEPS` | – | Max tool-loop steps per task (default 12). |
| `TELEMACHUS_EXEC_TIMEOUT_S` | – | Per-command timeout in the sandbox (default 180). |

> **Secrets stay in the environment.** Nothing is hardcoded or committed; `.env` is
> git-ignored. If a token ever leaks, revoke it (Telegram: @BotFather → `/revoke`).

**Finding your chat ID:** message your bot once, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.

---

## Using it

Once running, in your Telegram chat:

- **Send a task:** `build a FastAPI todo service with tests, then run the tests`
- **Type `/`** to open the menu:

| Command | Description |
|---|---|
| `/start` | Welcome + current model |
| `/help` | How to use it |
| `/model` | Switch the AI model (live list of reachable frontier models) |
| `/settings` | View settings · switch model · new session |
| `/status` | Current model, sandbox id, busy state |
| `/stop` | Stop the agent's current task |
| `/new` | Fresh session (new sandbox, cleared history) |

While it works you'll see a live message like:

```
🦞 Working · kimi-k2.6 (nvidia)
────────────
$ python -m venv .venv && . .venv/bin/activate && pip install fastapi pytest
Successfully installed fastapi-0.115 ...
$ cat > app.py << 'EOF' ... EOF
$ pytest -q
4 passed in 0.21s
✅ done · 6 step(s)
```

…then the clean final result (with file paths) arrives as its own message.

---

## How it works

```
Telegram ⇄ Telemachus bot ⇄ frontier model (NVIDIA/OpenRouter)
                  │
                  └── run_shell ⇄ Daytona sandbox (isolated cloud Linux microVM)
```

- **`src/bot.ts`** — Telegram long-poll loop, per-chat sessions, command menu, the
  live-progress message, and the final-result message.
- **`src/agent.ts`** — the bounded tool loop (think → `run_shell` → observe → repeat),
  openclaw-doctrine system prompt, and parsing for both OpenAI and Kimi-style tool calls.
- **`src/daytona.ts`** — creates/execs/deletes the cloud sandbox (one per chat session).
- **`src/providers.ts`** — OpenAI-compatible client for NVIDIA NIM + OpenRouter.
- **`src/models.ts`** — the frontier-model catalog and live availability check.

### Keeping it running 24/7

The bot is a plain Node process, so host it anywhere always-on — a small VPS,
`pm2 start dist/index.js --name telemachus`, a container, or even a Daytona sandbox of
its own. Execution already happens in the cloud; only the lightweight bot loop needs a
home.

---

## Credits

- Spin-off of [Qwenodyssey](https://github.com/Everaldtah/Qwenodyssey).
- Agent doctrine adapted (clean-room — design ideas only, no source copied) from
  [openclaw](https://github.com/openclaw/openclaw) (MIT).
- Cloud execution by [Daytona](https://daytona.io).

## License

MIT — see [LICENSE](LICENSE).
