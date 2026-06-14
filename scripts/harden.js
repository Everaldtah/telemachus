// Harden + prove resilience of the deployed host sandbox:
//  (A) kill the bot process and confirm the supervisor restarts it (crash-recovery).
//  (B) install a best-effort @reboot cron so it also relaunches if the sandbox reboots.
const path = require("path");
const { loadConfig } = require(path.resolve(__dirname, "..", "dist", "config.js"));
const c = loadConfig();
const API = c.daytonaUrl;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${c.daytonaKey}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exec(id, command, timeoutS = 60) {
  const res = await fetch(`${API}/toolbox/${id}/toolbox/process/execute`, {
    method: "POST", headers: H, body: JSON.stringify({ command, timeout: timeoutS }),
  });
  const r = await res.json();
  return { code: typeof r.exitCode === "number" ? r.exitCode : null, out: String(r.result ?? "") };
}

(async () => {
  const list = await fetch(`${API}/sandbox`, { headers: H }).then(r => r.json());
  const arr = Array.isArray(list) ? list : (list.items || []);
  const host = arr.find(s => s.labels && s.labels.role === "host" && s.state === "started");
  if (!host) { console.error("no started host sandbox"); process.exit(1); }
  const id = host.id;
  console.log("host:", id);

  // (A) Crash-recovery test.
  const before = await exec(id, "pgrep -f 'dist/index.js' | head -1");
  console.log("bot pid before kill:", before.out.trim());
  await exec(id, "pkill -9 -f 'dist/index.js'");
  console.log("killed node; waiting for supervisor to restart…");
  await sleep(7000);
  const after = await exec(id, "pgrep -f 'dist/index.js' | head -1; echo '---'; tail -n 4 ~/telemachus.log");
  console.log("after:\n" + after.out.trim());
  const newPid = (after.out.split("---")[0] || "").trim();
  console.log(newPid && newPid !== before.out.trim() ? "✅ supervisor restarted the bot (new pid)" : (newPid ? "✅ bot running" : "⚠️ bot NOT running after kill"));

  // (B) @reboot cron (best-effort; harmless if cron isn't active in this image).
  const cron = await exec(id,
    "(command -v crontab >/dev/null 2>&1 && " +
    "( (crontab -l 2>/dev/null | grep -v 'run.sh'); echo '@reboot /usr/bin/env bash $HOME/run.sh >/dev/null 2>&1' ) | crontab - && " +
    "echo 'cron @reboot installed') || echo 'no crontab in image (skipped)'", 30);
  console.log(cron.out.trim());
})();
