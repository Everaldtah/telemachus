import * as fs from "fs";
import * as path from "path";

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments, optional quotes. */
export function loadEnvFile(file = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export interface Config {
  telegramToken: string;
  allowedChatIds: number[];
  daytonaKey: string;
  daytonaUrl: string;
  daytonaSnapshot?: string;
  daytonaTarget?: string;
  /** Sandbox scratch disk in GB (0 = Daytona default ~3). Quota-bound. */
  daytonaDiskGb: number;
  /** Daytona Volume name to mount for large persistent (S3-backed) storage. */
  daytonaVolume?: string;
  /** Where the volume is mounted inside the sandbox. */
  daytonaVolumeMount: string;
  nvidiaKey: string;
  openrouterKey: string;
  /** Base URL for NVIDIA NIM. Default = the direct endpoint; set to the Vercel NIM proxy
   *  (e.g. https://telemachus-dashboard.vercel.app/api/nim) when egress to NVIDIA is blocked
   *  (Daytona EU). Must NOT include a trailing slash or /chat/completions. */
  nvidiaBaseUrl: string;
  defaultModel: string;
  maxSteps: number;
  execTimeoutS: number;
  /** Base URL of the swarm dashboard website (Vercel). Used to build per-session links. */
  dashboardUrl: string;
  /** Generic HTTP fetch proxy (Vercel) that gives the sandboxed agent general internet
   *  access — the Daytona EU sandbox resets direct egress, but reaches Vercel. Default
   *  derives from DASHBOARD_URL (+/api/fetch); override with WEB_PROXY_URL. "" disables. */
  webProxyUrl: string;
  /** OpenRouter multimodal model used to analyze web_fetch screenshots. */
  visionModel: string;
  /** Moltbook proxy URL (Vercel) — injects the API key server-side so the agent can use
   *  the AI-agent social network without the key ever touching the sandbox. Default derives
   *  from DASHBOARD_URL (+/api/moltbook); override with MOLTBOOK_PROXY_URL. "" disables. */
  moltbookProxyUrl: string;
}

export function loadConfig(): Config {
  loadEnvFile();
  const ids = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedChatIds: ids,
    daytonaKey: process.env.DAYTONA_API_KEY || "",
    daytonaUrl: (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, ""),
    daytonaSnapshot: process.env.DAYTONA_SNAPSHOT || undefined,
    daytonaTarget: process.env.DAYTONA_TARGET || undefined,
    daytonaDiskGb: Math.max(0, parseInt(process.env.DAYTONA_DISK_GB || "0", 10) || 0),
    daytonaVolume: process.env.DAYTONA_VOLUME || undefined,
    daytonaVolumeMount: process.env.DAYTONA_VOLUME_MOUNT || "/data",
    nvidiaKey: process.env.NVIDIA_API_KEY || "",
    openrouterKey: process.env.OPENROUTER_API_KEY || "",
    nvidiaBaseUrl: (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
    defaultModel: process.env.TELEMACHUS_MODEL || "openrouter:moonshotai/kimi-k2.7-code",
    maxSteps: Math.max(1, parseInt(process.env.TELEMACHUS_MAX_STEPS || "12", 10)),
    execTimeoutS: Math.max(5, parseInt(process.env.TELEMACHUS_EXEC_TIMEOUT_S || "180", 10)),
    dashboardUrl: (process.env.DASHBOARD_URL || "").replace(/\/+$/, ""),
    webProxyUrl: resolveWebProxyUrl(),
    visionModel: process.env.VISION_MODEL || "google/gemini-2.5-flash",
    moltbookProxyUrl: resolveMoltbookProxyUrl(),
  };
}

/** Moltbook proxy URL: explicit MOLTBOOK_PROXY_URL wins; otherwise derive from DASHBOARD_URL. */
function resolveMoltbookProxyUrl(): string {
  const explicit = (process.env.MOLTBOOK_PROXY_URL || "").replace(/\/+$/, "");
  if (explicit) return explicit;
  const dash = (process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
  return dash ? `${dash}/api/moltbook` : "";
}

/** Web fetch proxy URL: explicit WEB_PROXY_URL wins; otherwise derive from DASHBOARD_URL. */
function resolveWebProxyUrl(): string {
  const explicit = (process.env.WEB_PROXY_URL || "").replace(/\/+$/, "");
  if (explicit) return explicit;
  const dash = (process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
  return dash ? `${dash}/api/fetch` : "";
}

/** Provider key/base bundle passed to createProvider(). One source of truth so the NVIDIA
 *  base URL (direct vs proxy) is threaded everywhere. */
export function providerKeys(c: Config): { nvidia: string; openrouter: string; nvidiaBaseUrl: string } {
  return { nvidia: c.nvidiaKey, openrouter: c.openrouterKey, nvidiaBaseUrl: c.nvidiaBaseUrl };
}

/** Human-readable list of what's missing, for a friendly startup error. */
export function validateConfig(c: Config): string[] {
  const missing: string[] = [];
  if (!c.telegramToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (c.allowedChatIds.length === 0) missing.push("TELEGRAM_ALLOWED_CHAT_IDS");
  if (!c.daytonaKey) missing.push("DAYTONA_API_KEY");
  if (!c.nvidiaKey && !c.openrouterKey) missing.push("NVIDIA_API_KEY or OPENROUTER_API_KEY");
  return missing;
}
