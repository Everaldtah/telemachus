/**
 * Daytona sandbox executor: runs the agent's shell commands in an isolated cloud
 * microVM (https://daytona.io) so Telemachus works without touching your machine
 * and keeps running in the cloud. One sandbox per chat session; deleted on reset.
 * Dependency-free REST: POST /sandbox, POST /toolbox/{id}/toolbox/process/execute,
 * DELETE /sandbox/{id}. Bearer auth via the Daytona API key.
 */
export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface DaytonaOptions {
  apiKey: string;
  apiUrl: string;
  snapshot?: string;
  target?: string;
}

export class DaytonaSandbox {
  private sandboxId: string | null = null;
  private creating: Promise<string> | null = null;
  private disposed = false;

  constructor(private opts: DaytonaOptions) {}

  get id(): string | null {
    return this.sandboxId;
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` };
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`daytona HTTP ${res.status} on ${method} ${path}: ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  }

  private ensure(): Promise<string> {
    if (this.sandboxId) return Promise.resolve(this.sandboxId);
    if (!this.creating) {
      this.creating = (async () => {
        const body: Record<string, unknown> = {
          name: `telemachus-${Date.now().toString(36)}`,
          labels: { app: "telemachus" },
          autoStopInterval: 30,
          autoDeleteInterval: 1440,
        };
        if (this.opts.snapshot) body.snapshot = this.opts.snapshot;
        if (this.opts.target) body.target = this.opts.target;
        const sb = await this.api("POST", "/sandbox", body);
        const id: string = sb.id;
        const deadline = Date.now() + 120_000;
        let state: string = sb.state ?? "creating";
        while (state !== "started" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const cur = await this.api("GET", `/sandbox/${id}`);
          state = cur.state ?? state;
          if (state === "error" || cur.errorReason) {
            throw new Error(`daytona sandbox failed to start: ${cur.errorReason ?? state}`);
          }
        }
        if (state !== "started") throw new Error("daytona sandbox start timed out (120s)");
        await this.exec("touch /tmp/.telemachus_start", 10).catch(() => {});
        this.sandboxId = id;
        return id;
      })();
      this.creating.catch(() => (this.creating = null));
    }
    return this.creating;
  }

  async run(command: string, timeoutMs = 180_000): Promise<ExecResult> {
    if (this.disposed) return { ok: false, exitCode: null, output: "sandbox disposed" };
    try {
      const id = await this.ensure();
      return await this.exec(command, Math.ceil(timeoutMs / 1000), id);
    } catch (err) {
      return { ok: false, exitCode: null, output: (err as Error).message };
    }
  }

  private async exec(command: string, timeoutS: number, id?: string): Promise<ExecResult> {
    const sb = id ?? this.sandboxId;
    if (!sb) return { ok: false, exitCode: null, output: "no sandbox" };
    const res = await this.api("POST", `/toolbox/${sb}/toolbox/process/execute`, {
      command,
      timeout: Math.max(1, timeoutS),
    });
    const exitCode = typeof res.exitCode === "number" ? res.exitCode : null;
    return { ok: exitCode === 0, exitCode, output: String(res.result ?? "") };
  }

  /** Files created in the sandbox since startup (for the final report). */
  async artifacts(): Promise<string[]> {
    if (!this.sandboxId) return [];
    const r = await this.run(
      "find . ~ -maxdepth 3 -type f -newer /tmp/.telemachus_start -not -path '*/.*' 2>/dev/null | sort -u | head -60",
      30_000
    );
    return (r.output || "").split("\n").map((s) => s.trim()).filter(Boolean);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sandboxId) {
      await this.api("DELETE", `/sandbox/${this.sandboxId}`).catch(() => {});
      this.sandboxId = null;
    }
  }
}
