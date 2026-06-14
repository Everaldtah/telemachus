// Tail the host sandbox log + show recent bot activity.
const path = require("path");
const { loadConfig } = require(path.resolve(__dirname, "..", "dist", "config.js"));
const c = loadConfig();
const API = c.daytonaUrl, H = { "Content-Type": "application/json", Authorization: `Bearer ${c.daytonaKey}` };
async function exec(id, command, timeoutS = 60) {
  const res = await fetch(`${API}/toolbox/${id}/toolbox/process/execute`, {
    method: "POST", headers: H, body: JSON.stringify({ command, timeout: timeoutS }) });
  const r = await res.json();
  return { code: r.exitCode, out: String(r.result ?? "") };
}
(async () => {
  const list = await fetch(`${API}/sandbox`, { headers: H }).then(r => r.json());
  const arr = Array.isArray(list) ? list : (list.items || []);
  const host = arr.find(s => s.labels && s.labels.role === "host");
  console.log("host:", host && host.id, host && host.state);
  if (!host) return;
  const r = await exec(host.id, "tail -n 60 ~/telemachus.log", 30);
  console.log("=== telemachus.log (tail 60) ===\n" + r.out);
})();
