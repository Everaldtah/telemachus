// Probe Daytona API: inspect an existing sandbox's fields (to learn autoStop /
// autoDelete / env support) and confirm we can GET/create. Prints no secrets.
const path = require("path");
const { loadConfig } = require(path.resolve(__dirname, "..", "dist", "config.js"));
const c = loadConfig();
const H = { "Content-Type": "application/json", Authorization: `Bearer ${c.daytonaKey}` };

(async () => {
  // List sandboxes, then GET the first one in full to see the field shape.
  const list = await fetch(`${c.daytonaUrl}/sandbox`, { headers: H }).then(r => r.json());
  const arr = Array.isArray(list) ? list : (list.items || list.sandboxes || []);
  console.log("count:", arr.length);
  if (arr[0]) {
    const full = await fetch(`${c.daytonaUrl}/sandbox/${arr[0].id}`, { headers: H }).then(r => r.json());
    console.log("sample sandbox keys:", Object.keys(full).join(", "));
    console.log("autoStopInterval:", full.autoStopInterval, "| autoDeleteInterval:", full.autoDeleteInterval,
      "| autoArchiveInterval:", full.autoArchiveInterval, "| state:", full.state, "| cpu:", full.cpu, "| memory:", full.memory);
    console.log("env present:", !!full.env, "| target:", full.target, "| snapshot:", full.snapshot, "| image:", full.image);
  }
  // Fetch the OpenAPI to see CreateSandbox accepted fields (env, autoStopInterval, etc.)
  try {
    const spec = await fetch(`${c.daytonaUrl}/openapi.json`, { headers: H }).then(r => r.ok ? r.json() : null);
    if (spec) {
      const schema = spec.components?.schemas?.CreateSandbox || spec.components?.schemas?.CreateSandboxDto;
      if (schema) console.log("CreateSandbox props:", Object.keys(schema.properties || {}).join(", "));
      else console.log("CreateSandbox schema not found; schema names:", Object.keys(spec.components?.schemas||{}).filter(n=>/create.*sandbox/i.test(n)).join(", "));
    } else {
      console.log("no openapi.json");
    }
  } catch (e) { console.log("openapi err:", e.message); }
})();
