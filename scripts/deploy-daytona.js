/**
 * Deploy Telemachus as an ALWAYS-ON bot inside a persistent Daytona sandbox.
 *
 * - Creates one long-lived "host" sandbox with auto-stop DISABLED (autoStopInterval:0)
 *   and auto-delete disabled, so it keeps running after this PC is off.
 * - Injects all secrets as sandbox ENV VARS (no .env file written, no secret echoed
 *   in a shell command).
 * - Uploads the prebuilt, dependency-free dist (base64 tarball over the toolbox exec
 *   API) so the sandbox needs only `node` — no git/npm/registry.
 * - Launches the bot under a bash supervisor that restarts it if it ever crashes.
 *
 * Re-running replaces any previous host sandbox cleanly (idempotent).
 * Prints NO secrets.
 */
const fs = require("fs");
const path = require("path");
const { loadConfig } = require(path.resolve(__dirname, "..", "dist", "config.js"));

const c = loadConfig();
const API = c.daytonaUrl;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${c.daytonaKey}` };
const TARBALL = path.resolve(__dirname, "telemachus-dist.tgz");

async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${p}: ${txt.slice(0, 300)}`);
  try { return txt ? JSON.parse(txt) : {}; } catch { return { raw: txt }; }
}

async function exec(id, command, timeoutS = 120) {
  const r = await api("POST", `/toolbox/${id}/toolbox/process/execute`, { command, timeout: timeoutS });
  return { code: typeof r.exitCode === "number" ? r.exitCode : null, out: String(r.result ?? "") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStarted(id, ms = 150000) {
  const deadline = Date.now() + ms;
  let state = "";
  while (Date.now() < deadline) {
    const cur = await api("GET", `/sandbox/${id}`);
    state = cur.state;
    if (state === "started") return;
    if (state === "error" || cur.errorReason) throw new Error(`sandbox error: ${cur.errorReason || state}`);
    process.stdout.write(`  …state=${state}\r`);
    await sleep(2500);
  }
  throw new Error(`start timed out (state=${state})`);
}

(async () => {
  // 1) Tear down any previous host sandbox so we deploy clean.
  const list = await api("GET", "/sandbox");
  const arr = Array.isArray(list) ? list : (list.items || []);
  for (const s of arr) {
    if (s.labels && s.labels.role === "host" && s.labels.app === "telemachus") {
      console.log("removing old host sandbox", s.id, `(state ${s.state})`);
      await api("DELETE", `/sandbox/${s.id}`).catch((e) => console.log("  delete warn:", e.message));
    }
  }

  // 2) Create the persistent host sandbox with secrets injected + auto-stop disabled.
  const env = {
    TELEGRAM_BOT_TOKEN: c.telegramToken,
    TELEGRAM_ALLOWED_CHAT_IDS: c.allowedChatIds.join(","),
    DAYTONA_API_KEY: c.daytonaKey,
    DAYTONA_API_URL: c.daytonaUrl,
    NVIDIA_API_KEY: c.nvidiaKey,
    OPENROUTER_API_KEY: c.openrouterKey,
    NVIDIA_BASE_URL: c.nvidiaBaseUrl,
    TELEMACHUS_MODEL: c.defaultModel,
  };
  if (c.dashboardUrl) env.DASHBOARD_URL = c.dashboardUrl;
  if (c.openrouterKey) env.OPENROUTER_API_KEY = c.openrouterKey;
  if (c.daytonaVolume) { env.DAYTONA_VOLUME = c.daytonaVolume; env.DAYTONA_VOLUME_MOUNT = c.daytonaVolumeMount; }

  const body = {
    name: `telemachus-host-${Date.now().toString(36)}`,
    labels: { app: "telemachus", role: "host" },
    env,
    autoStopInterval: 0,    // 0 = never auto-stop  → stays running 24/7
    autoDeleteInterval: -1, // -1 = never auto-delete
  };
  console.log("creating persistent host sandbox (auto-stop disabled)…");
  const sb = await api("POST", "/sandbox", body);
  const id = sb.id;
  console.log("  id =", id);
  await waitStarted(id);
  console.log("\n  started.");

  // 3) Probe runtime; ensure node is present (install if the base image lacks it).
  let probe = await exec(id, "node -v 2>/dev/null; echo '---'; tar --version 2>/dev/null | head -1; echo '---'; uname -sr", 60);
  console.log("probe:\n" + probe.out.trim());
  if (!/v\d+\./.test(probe.out)) {
    console.log("node missing — installing Node 20…");
    const inst = await exec(
      id,
      "(command -v curl || (apt-get update && apt-get install -y curl)) >/dev/null 2>&1; " +
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && " +
        "apt-get install -y nodejs >/dev/null 2>&1; node -v",
      300
    );
    console.log("  node now:", inst.out.trim());
    if (!/v\d+\./.test(inst.out)) throw new Error("could not install node in sandbox");
  }

  // 4) Upload the prebuilt dist (base64 tarball) and extract it.
  const b64 = fs.readFileSync(TARBALL).toString("base64");
  console.log(`uploading code (${b64.length} b64 chars)…`);
  const up = await exec(
    id,
    `mkdir -p ~/telemachus && printf '%s' '${b64}' | base64 -d | tar xzf - -C ~/telemachus && ls ~/telemachus/dist | tr '\\n' ' '`,
    120
  );
  if (up.code !== 0) throw new Error("upload/extract failed: " + up.out);
  console.log("  dist files:", up.out.trim());

  // 5) Write the supervisor + launch it detached so it survives crashes.
  const runScript = [
    "#!/usr/bin/env bash",
    "cd ~/telemachus",
    "while true; do",
    '  echo "[supervisor $(date -u +%FT%TZ)] starting bot" >> ~/telemachus.log',
    "  node dist/index.js >> ~/telemachus.log 2>&1",
    '  echo "[supervisor $(date -u +%FT%TZ)] bot exited ($?), restart in 3s" >> ~/telemachus.log',
    "  sleep 3",
    "done",
  ].join("\n");
  const runB64 = Buffer.from(runScript, "utf8").toString("base64");
  await exec(id, `printf '%s' '${runB64}' | base64 -d > ~/run.sh && chmod +x ~/run.sh`, 30);

  // Kill any stray instance, then start fresh detached.
  await exec(id, "pkill -f 'dist/index.js' 2>/dev/null; pkill -f run.sh 2>/dev/null; sleep 1; : ", 20);
  await exec(
    id,
    "setsid bash ~/run.sh </dev/null >/dev/null 2>&1 & echo launched; sleep 1; echo ok",
    20
  );

  // 6) Verify it came up: wait, then read the log + process list.
  await sleep(6000);
  const ps = await exec(id, "pgrep -af 'dist/index.js' | head -3; echo '--- log ---'; tail -n 15 ~/telemachus.log", 30);
  console.log("\n=== sandbox status ===\n" + ps.out.trim());

  console.log("\nHOST_SANDBOX_ID=" + id);
})().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
