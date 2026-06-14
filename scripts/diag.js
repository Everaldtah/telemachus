// One-off diagnostic: verifies Telegram token + pending updates, and Daytona key.
// Reads .env via the project's own loader. Prints NO secrets.
const path = require("path");
const { loadConfig } = require(path.resolve(__dirname, "..", "dist", "config.js"));
const c = loadConfig();

function mask(s) { return s ? `set(len ${s.length})` : "MISSING"; }

(async () => {
  console.log("config:",
    "telegram", mask(c.telegramToken),
    "| daytona", mask(c.daytonaKey),
    "| nvidia", mask(c.nvidiaKey),
    "| chatIds", JSON.stringify(c.allowedChatIds),
    "| model", c.defaultModel);

  // 1) Telegram getMe
  try {
    const me = await fetch(`https://api.telegram.org/bot${c.telegramToken}/getMe`).then(r => r.json());
    console.log("getMe:", me.ok ? `@${me.result.username} (id ${me.result.id})` : JSON.stringify(me));
  } catch (e) { console.log("getMe ERROR:", e.message); }

  // 2) Telegram getUpdates (non-destructive peek). If another consumer is polling,
  //    this still returns; conflict (409) shows another bot instance is live.
  try {
    const u = await fetch(`https://api.telegram.org/bot${c.telegramToken}/getUpdates?timeout=0&limit=5`).then(r => r.json());
    if (!u.ok) { console.log("getUpdates:", JSON.stringify(u)); }
    else {
      console.log("getUpdates: ok, pending =", u.result.length);
      for (const up of u.result) {
        const m = up.message || up.edited_message;
        if (m) console.log("  msg from", m.chat && m.chat.id, ":", JSON.stringify((m.text||"").slice(0,60)), "at", new Date(m.date*1000).toISOString());
      }
    }
  } catch (e) { console.log("getUpdates ERROR:", e.message); }

  // 3) Daytona: list sandboxes (confirms key + shows any lingering telemachus sandboxes)
  try {
    const r = await fetch(`${c.daytonaUrl}/sandbox`, { headers: { Authorization: `Bearer ${c.daytonaKey}` } });
    const txt = await r.text();
    if (!r.ok) { console.log("daytona /sandbox HTTP", r.status, txt.slice(0,200)); }
    else {
      let arr = []; try { arr = JSON.parse(txt); } catch {}
      const list = Array.isArray(arr) ? arr : (arr.items || arr.sandboxes || []);
      console.log("daytona sandboxes:", list.length);
      for (const s of list.slice(0, 20)) {
        console.log("  -", s.id, "| state", s.state, "| name", s.name, "| labels", JSON.stringify(s.labels||{}));
      }
    }
  } catch (e) { console.log("daytona ERROR:", e.message); }
})();
