/**
 * Running a command inside a sprite.
 *
 * ## The HTTP endpoint does not do this
 *
 * `POST /v1/sprites/{name}/exec` answers `200` and two bytes (`03 00`) and
 * **runs nothing**. That is not a subtlety — a command told to create a file
 * returned 200 and the file did not exist. An earlier version of this code was
 * built on the belief that it was a fire-and-forget executor, which meant a
 * pool of machines was created, recorded as building, and never touched again.
 * The `sprite-capabilities: control-ws` header on that response is the hint:
 * the real channel is a WebSocket.
 *
 * ## The protocol, established by experiment on 2026-08-27
 *
 *   wss://api.sprites.dev/v1/sprites/{name}/exec?cmd=<argv0>&cmd=<argv1>&…
 *   Authorization: Bearer <token>
 *
 * **argv is a REPEATED `cmd` parameter.** Not `args`, not `arg`, not `argv`,
 * not a JSON body — each was tried and each produced a command running with no
 * arguments at all, which for `touch` is exit 1 and for `sh` is exit 0 having
 * read nothing. `?cmd=touch&cmd=/tmp/x` creates `/tmp/x`; `?cmd=touch&args=…`
 * does not. Exit codes are how that was settled, and they are the reason this
 * matters beyond correctness: this channel REPORTS RESULTS.
 *
 * The server sends JSON text frames — `{"type":"session_info",…}`, debug lines,
 * and finally `{"type":"exit","exit_code":N}` — interleaved with binary frames
 * carrying stdout and stderr.
 *
 * ## What this is not for
 *
 * Anything that takes minutes. A 25-minute install held open on a WebSocket is
 * a 25-minute opportunity for a network to blink. Long work is started here and
 * supervised by a sprite *service*, which survives both this connection closing
 * and the machine being paused for a week.
 */
import WebSocket from "ws";

export interface SpriteExecResult {
  /** The command's exit status, or null if the connection died before one. */
  exitCode: number | null;
  /** Anything the command wrote, best-effort, for a log line when it fails. */
  output: string;
  /** False when the socket failed, was refused, or timed out. */
  ok: boolean;
  error?: string;
}

export interface SpriteExecOptions {
  token: string;
  apiBase?: string;
  /** How long to wait for an exit before giving up. */
  timeoutMs?: number;
  /** Injected in tests. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

/** Long enough for an apt install to finish, short enough to not hang a sweep. */
export const EXEC_TIMEOUT_MS = 120_000;

/**
 * Build the exec URL.
 *
 * Separate and exported because the repeated-`cmd` shape is the single most
 * surprising thing here, and a test that pins it is cheaper than rediscovering
 * it. `argv[0]` is the binary; everything after it is an argument.
 */
export function spriteExecUrl(input: {
  apiBase: string;
  name: string;
  argv: readonly string[];
}): string {
  const base = input.apiBase.replace(/\/+$/, "").replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const qs = input.argv.map((a) => `cmd=${encodeURIComponent(a)}`).join("&");
  return `${base}/v1/sprites/${encodeURIComponent(input.name)}/exec?${qs}`;
}

/**
 * Hold a machine RUNNING until released.
 *
 * The measured difference between this and {@link spriteExec}: an
 * instantaneous command leaves a Sprite at `warm` — awake enough to answer,
 * frozen between calls — while a session that STAYS OPEN keeps it `running`.
 * Verified 2026-08-27: `cold` at t+0, `running` at t+1m and still running at
 * t+2m with the socket held.
 *
 * The command is a trivial heartbeat. Its output is irrelevant and is
 * discarded; what matters is that the session exists. Cheap by construction —
 * a `sleep` loop costs nothing next to the agent turn this is protecting.
 *
 * Reconnects on its own, because the whole point is to outlast a long turn and
 * a dropped socket would silently stop paying for the thing it was protecting.
 */
export function spriteHold(opts: SpriteExecOptions) {
  const apiBase = opts.apiBase ?? "https://api.sprites.dev";
  const connect = opts.connect ?? ((url, headers) => new WebSocket(url, { headers }));

  return function hold(name: string): { release(): void } {
    let released = false;
    let ws: WebSocket | undefined;
    let retry: NodeJS.Timeout | undefined;

    const open = () => {
      if (released) return;
      const url = spriteExecUrl({
        apiBase,
        name,
        argv: ["sh", "-c", "while true; do echo .; sleep 5; done"],
      });
      try {
        ws = connect(url, { authorization: `Bearer ${opts.token}` });
      } catch {
        schedule();
        return;
      }
      ws.on("error", () => { /* close follows */ });
      ws.on("close", () => {
        ws = undefined;
        // A hold that quietly stopped holding is worse than no hold: the caller
        // believes the machine is protected while it suspends mid-turn.
        schedule();
      });
    };

    const schedule = () => {
      if (released || retry) return;
      retry = setTimeout(() => { retry = undefined; open(); }, 2_000);
      retry.unref?.();
    };

    open();

    return {
      release() {
        released = true;
        if (retry) { clearTimeout(retry); retry = undefined; }
        try { ws?.close(); } catch { /* already gone */ }
        ws = undefined;
      },
    };
  };
}

export function spriteExec(opts: SpriteExecOptions) {
  const apiBase = opts.apiBase ?? "https://api.sprites.dev";
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  const connect = opts.connect
    ?? ((url, headers) => new WebSocket(url, { headers }));

  return async function exec(name: string, argv: readonly string[]): Promise<SpriteExecResult> {
    if (argv.length === 0) return { ok: false, exitCode: null, output: "", error: "no command" };
    const url = spriteExecUrl({ apiBase, name, argv });

    return new Promise<SpriteExecResult>((resolve) => {
      let settled = false;
      let exitCode: number | null = null;
      const chunks: string[] = [];

      const finish = (r: SpriteExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already gone */ }
        resolve(r);
      };

      const timer = setTimeout(
        () => finish({ ok: false, exitCode: null, output: chunks.join(""), error: "timeout" }),
        timeoutMs,
      );

      let ws: WebSocket;
      try {
        ws = connect(url, { authorization: `Bearer ${opts.token}` });
      } catch (e) {
        clearTimeout(timer);
        return resolve({ ok: false, exitCode: null, output: "", error: (e as Error).message });
      }

      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary?: boolean) => {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        // Only the JSON control frames matter for the verdict. Binary frames are
        // stdout/stderr and are kept purely so a failure can say what happened.
        if (!isBinary && text.startsWith("{")) {
          try {
            const msg = JSON.parse(text) as { type?: string; exit_code?: number };
            if (msg.type === "exit" && typeof msg.exit_code === "number") {
              exitCode = msg.exit_code;
              // Do NOT resolve yet: the socket close carries any trailing
              // output, and closing early on a fast command loses stderr that
              // is the whole reason anyone reads this.
            }
            return;
          } catch { /* not control JSON; fall through and keep it as output */ }
        }
        if (chunks.length < 200) chunks.push(text);
      });

      ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
        finish({
          ok: false, exitCode: null, output: "",
          error: `http ${res.statusCode ?? "?"}`,
        });
      });

      ws.on("error", (e: Error) => {
        finish({ ok: false, exitCode, output: chunks.join(""), error: e.message });
      });

      ws.on("close", () => {
        finish({
          ok: exitCode !== null,
          exitCode,
          output: chunks.join(""),
          ...(exitCode === null ? { error: "closed before exit" } : {}),
        });
      });
    });
  };
}
