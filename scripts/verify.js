// Post-deploy verification: (1) Telegram getUpdates should now 409 (a consumer is
// actively long-polling = our cloud bot). (2) Confirm host sandbox auto-stop disabled.
const path = require("path");
const { loadConfig } = require(path.resolve(__dirname, "..", "dist", "config.js"));
const c = loadConfig();
const H = { Authorization: `Bearer ${c.daytonaKey}` };

(async () => {
  const u = await fetch(`https://api.telegram.org/bot${c.telegramToken}/getUpdates?timeout=0&offset=-1`).then(r => r.json());
  if (!u.ok && u.error_code === 409) {
    console.log("✅ Telegram: 409 Conflict — a consumer IS actively polling (the cloud bot). Good.");
  } else if (u.ok) {
    console.log("⚠️ Telegram: getUpdates returned ok (pending=" + u.result.length + ") — no active consumer? bot may be down.");
  } else {
    console.log("Telegram getUpdates:", JSON.stringify(u));
  }

  const list = await fetch(`${c.daytonaUrl}/sandbox`, { headers: H }).then(r => r.json());
  const arr = Array.isArray(list) ? list : (list.items || []);
  const host = arr.find(s => s.labels && s.labels.role === "host");
  if (host) {
    console.log(`✅ Host sandbox ${host.id}: state=${host.state}, autoStopInterval=${host.autoStopInterval} (0 = never stop), autoDeleteInterval=${host.autoDeleteInterval}`);
  } else {
    console.log("⚠️ no host sandbox found");
  }
  console.log("total sandboxes:", arr.length, "—", arr.map(s => `${s.labels?.role||"exec"}:${s.state}`).join(", "));
})();
