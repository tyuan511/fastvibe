import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The tunnel that publishes the remote server.
 *
 * `server.ts` binds to loopback on purpose — a mistake in the settings pane must not be
 * able to put an agent with shell access onto the local network — so something has to
 * carry it to the internet. That used to be a paragraph of instructions under the
 * address, and a paragraph of instructions is a feature nobody finishes: copy the port,
 * find a terminal, remember `--url`, then read a URL off a terminal and type it into a
 * phone by hand.
 *
 * So the app runs the tunnel itself. Not by shipping one: `cloudflared` and `ngrok` are
 * both ~30 MB binaries with their own update channels and, in ngrok's case, an account,
 * and bundling either would mean shipping a stale copy of somebody else's client. The
 * user installs the one they want; this module finds it, runs it, and reads the public
 * URL out of its output.
 *
 * Deliberately Electron-free, like the rest of `server/`: it is handed a logger and a
 * callback, and everything that knows about settings or windows lives in
 * `src/main/remote.ts`.
 */

export type TunnelProvider = "cloudflared" | "ngrok" | "frp";

/**
 * What a run needs beyond the port, for a provider that is configured rather than
 * discovered. Only frp has any: the config file `frpc` reads, and the public URL, which
 * frpc never prints (it depends on how the *server* was set up) and is therefore worked
 * out from the config before the run instead of read out of its output.
 */
export type TunnelOptions = {
  configFile?: string;
  publicUrl?: string;
};

/**
 * `off` → nothing running. `starting` → the process is up but has not printed a URL
 * yet, which is the state the pane spends five to fifteen seconds in. `online` → a URL
 * is in hand. `error` → it exited, timed out, or was never found.
 */
export type TunnelPhase = "off" | "starting" | "online" | "error";

export type TunnelStatus = {
  provider: TunnelProvider | null;
  phase: TunnelPhase;
  /** The public https URL, once the tool has printed one. */
  url: string | null;
  error: string | null;
  /**
   * The tail of the tool's own output.
   *
   * Shown in the pane when it fails, because the useful sentence is almost always the
   * tool's, not ours: ngrok explains that the authtoken is missing and names the command
   * that fixes it, and cloudflared explains that it could not reach its edge. Neither is
   * something this module could have written, and sending the user to the app log for it
   * is sending them somewhere they will not go.
   */
  output: string[];
  /**
   * The failure is a missing or rejected credential, not anything about the network.
   *
   * Its own flag rather than a sentence the pane matches on, because what it buys is a
   * different *control*: there is exactly one command that fixes it, and the pane can
   * put that command on screen with a copy button instead of an error the user has to
   * interpret. ngrok is the only provider that can reach this state.
   */
  needsAuth: boolean;
};

/** What a provider's binary looks like on this machine. */
export type TunnelToolInfo = {
  installed: boolean;
  /** Where it was found, so the pane can say *which* copy is about to run. */
  path: string | null;
  /** Its own `--version` line, which also proves the file actually executes. */
  version: string | null;
  /**
   * Whether the credential this tool needs is on this machine.
   *
   * `true` when it is, `false` when it positively is not, and `null` when the question
   * does not apply (a Cloudflare quick tunnel needs no account) or cannot be answered.
   * Only `false` is acted on, so a detection that cannot tell never blocks anybody.
   */
  authenticated: boolean | null;
};

export type TunnelTools = Record<TunnelProvider, TunnelToolInfo>;

export const TUNNEL_PROVIDERS: readonly TunnelProvider[] = ["cloudflared", "ngrok", "frp"];

/** The status of a runner that has never been asked to do anything. */
export const TUNNEL_OFF: TunnelStatus = {
  provider: null,
  phase: "off",
  url: null,
  error: null,
  output: [],
  needsAuth: false,
};

export function isTunnelProvider(value: unknown): value is TunnelProvider {
  return typeof value === "string" && (TUNNEL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * How long a tool gets to print a URL before it is given up on.
 *
 * Generous because the slow case is real and not a fault: a Cloudflare quick tunnel
 * registers with the nearest edge, and on a bad network that is tens of seconds. What
 * this is actually protecting against is the tool that is up, silent, and never going to
 * say anything — an ngrok waiting on a TCP connection it will not get — which otherwise
 * leaves the pane in 启动中… forever with no way to tell it apart from slow.
 */
const START_TIMEOUT_MS = 60_000;

/** How long a `--version` probe gets. It is a local exec; anything slower is broken. */
const VERSION_TIMEOUT_MS = 4_000;

/** Lines of the tool's output kept for the pane. */
const OUTPUT_LINES = 12;

/** Longest single line kept. cloudflared's banner art is wider than any screen. */
const OUTPUT_LINE_CHARS = 400;

/** How long a stopped process gets to exit on its own before it is killed outright. */
const KILL_GRACE_MS = 3_000;

/** A reason a run is over, and whether the fix is a credential. */
type Failure = { message: string; needsAuth: boolean };

type ProviderSpec = {
  /** The binary's name, as each project's own install instructions spell it. */
  command: string;
  /** Arguments that publish `port` and keep the output parseable. */
  args: (port: number, options: TunnelOptions) => string[];
  /** The public URL in one line of output, or null. */
  url: (line: string, options: TunnelOptions) => string | null;
  /**
   * Why this run cannot start with the options it was given, or null.
   *
   * A configured provider with no configuration would otherwise spawn, fail to parse
   * nothing, and quote the tool's usage text back at the user.
   */
  unconfigured?: (options: TunnelOptions) => string | null;
  /** A line worth quoting back as the reason it failed, or null. */
  problem: (line: string) => string | null;
  /**
   * A line that means this run will never succeed, so there is nothing to wait for.
   *
   * Not the same question as `problem`, which only picks the sentence to quote once
   * something has already ended. This one *ends* it. ngrok with no authtoken is the
   * case that made it necessary: it does not exit, it logs the refusal and drops into a
   * reconnect loop — so the run stayed in 启动中 for the full sixty-second timeout and
   * then blamed the timeout, with the real reason twelve lines up in the output.
   */
  fatal?: (line: string) => Failure | null;
  /**
   * The credential the tool needs before it will run at all, when it needs one.
   *
   * Checked before anything is spawned, and read by `probeTunnelTools` for the pane —
   * one function, so what the pane shows and what the start path enforces cannot
   * disagree about whether this machine is set up.
   */
  credential?: {
    /** `true` present, `false` positively absent, `null` cannot tell. */
    present: () => boolean | null;
    /** What to say when it is absent. The pane pairs this with the fix. */
    missing: string;
  };
};

const PROVIDERS: Record<TunnelProvider, ProviderSpec> = {
  /**
   * Cloudflare's quick tunnel: free, no account, no config file.
   *
   * `--no-autoupdate` because the default is to replace its own binary and restart —
   * which on a Homebrew install is a write it cannot make, and on any install is a
   * restart that would silently change the URL the user is looking at.
   *
   * The URL arrives inside an ASCII banner on stderr, so it is matched rather than
   * parsed: the surrounding box is decoration and changes between releases.
   */
  cloudflared: {
    command: "cloudflared",
    args: (port) => ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    url: (line) => firstMatch(line, /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i),
    problem: (line) => (/\b(?:ERR|FATA)\b|failed to|error=/i.test(line) ? line : null),
  },

  /**
   * ngrok, which needs a (free) account and one `ngrok config add-authtoken` first.
   *
   * `--log=stdout --log-format=json` does two things: it turns off the full-screen TUI,
   * which is unreadable when it is piped rather than drawn on a terminal, and it makes
   * every line a JSON object — so the URL is read out of a named field instead of
   * scraped from a layout.
   *
   * Nothing is passed for `--host-header`. The server's `#originAllowed` accepts all
   * three shapes a tunnel can produce (`Host` preserved, `X-Forwarded-Host` set, or any
   * `X-Forwarded-*` at all), so every ngrok version works untouched — and a flag value
   * one of them spells differently would be a failure to start rather than a fallback.
   */
  ngrok: {
    command: "ngrok",
    args: (port) => ["http", String(port), "--log=stdout", "--log-format=json"],
    url: ngrokUrl,
    problem: ngrokProblem,
    fatal: ngrokFatal,
    credential: {
      present: ngrokAuthtoken,
      missing: "ngrok \u8fd8\u6ca1\u6709\u914d\u7f6e authtoken\uff0c\u672a\u8ba4\u8bc1\u65f6\u5b83\u4e0d\u4f1a\u5efa\u7acb\u96a7\u9053",
    },
  },

  /**
   * The user's own frps, dialled by `frpc -c <file>`.
   *
   * The config is written by `remote.ts` from 远程访问 → 内网穿透 (the token lives in
   * `frp.json`, never in `settings.json`), so all this side passes is the path. The URL
   * is not in the output at all — frpc says a proxy was registered, not where it can be
   * reached — so `start proxy success` is the "online" signal and the address is the one
   * derived from the config.
   */
  frp: {
    command: "frpc",
    args: (_port, options) => ["-c", options.configFile ?? ""],
    url: (line, options) => (options.publicUrl && frpOnline(line) ? options.publicUrl : null),
    problem: (line) => (/\[(?:E|W)\]|\berror\b|failed/i.test(line) ? line : null),
    fatal: frpFatal,
    unconfigured: (options) =>
      options.configFile && options.publicUrl
        ? null
        : "\u8bf7\u5148\u586b\u5199 frp \u670d\u52a1\u5668\u914d\u7f6e",
  },
};

/** frpc's line for a proxy frps accepted: `[fastvibe-ab12cd] start proxy success`. */
function frpOnline(line: string): boolean {
  return /start proxy success/i.test(line);
}

/**
 * frpc lines that mean this run is over.
 *
 * A refused proxy (`start error: port already used`, `router config conflict`, a domain
 * frps does not allow) is retried by frpc every so often, forever, with the same answer;
 * a refused token exits by itself only because the config sets `loginFailExit`. Both are
 * a fix the user has to make on one side or the other, so both end the run with frpc's
 * own words. A connection refused or a timeout is *not* here: frps restarting is the
 * normal case of that, and frpc recovering from it is the behaviour we want.
 *
 * Exported for its test, like `authtokenInConfig`: it is matching someone else's prose.
 */
export function frpFatal(line: string): Failure | null {
  const unreachable = frpUnreachable(line);
  if (unreachable) return { message: unreachable, needsAuth: false };
  if (/token in login doesn't match|authorization failed|invalid token/i.test(line)) {
    return { message: "frp \u8ba4\u8bc1\u5931\u8d25\uff1atoken \u4e0e frps \u7684 auth.token \u4e0d\u4e00\u81f4", needsAuth: false };
  }
  const refused = line.match(/start error:\s*(.+)$/i);
  if (refused) {
    return { message: `frps \u62d2\u7edd\u4e86\u8fd9\u4e2a\u4ee3\u7406\uff1a${refused[1].trim()}`, needsAuth: false };
  }
  return null;
}

/**
 * The first login never reached frps — the one failure the user has to fix outside
 * both FastVibe and frpc.
 *
 * Only the *login* line: `loginFailExit` makes frpc exit on it anyway, so this changes
 * the sentence, not the outcome. A dropped connection later (`connect to server error`)
 * is still frps restarting, which frpc rides out.
 *
 * The sentence is the point. A timeout is packets dropped on the way — on a cloud server
 * almost always the provider's security group, which nothing on this machine or on the
 * server can open — so it names the port and sends the user to the console for it,
 * instead of quoting `i/o timeout` and leaving them (or an agent) to route around it
 * with another port or another tunnel. A refusal is the port answering with nobody
 * behind it: frps is down or listens elsewhere, or a host firewall rejects.
 */
function frpUnreachable(line: string): string | null {
  if (!/login to (?:the )?server failed/i.test(line)) return null;
  const target = line.match(/dial tcp (\S+?):\s/i)?.[1] ?? "";
  const port = target.match(/:(\d+)$/)?.[1] ?? "";
  const where = target ? `\uff08${target}\uff09` : "";
  if (/i\/o timeout|timed out|no route to host/i.test(line)) {
    return (
      `\u8fde\u4e0d\u4e0a frps \u670d\u52a1\u5668${where}\uff1a\u8fde\u63a5\u8d85\u65f6\u3002` +
      `\u670d\u52a1\u5668\u4e0a frps \u5728\u8fd0\u884c\u7684\u8bdd\uff0c\u51e0\u4e4e\u4e00\u5b9a\u662f\u4e91\u5382\u5546\u7684\u5b89\u5168\u7ec4\u6216\u670d\u52a1\u5668\u9632\u706b\u5899\u6ca1\u6709\u653e\u884c` +
      (port ? ` TCP ${port}` : "\u8fd9\u4e2a\u7aef\u53e3") +
      `\u3002\u8bf7\u5230\u4e91\u670d\u52a1\u5668\u63a7\u5236\u53f0\u7684\u5b89\u5168\u7ec4\u91cc\u6dfb\u52a0\u5165\u65b9\u5411\u89c4\u5219\u653e\u884c\u5b83\uff0c\u7136\u540e\u91cd\u8bd5\u3002`
    );
  }
  if (/connection refused/i.test(line)) {
    return (
      `frps \u670d\u52a1\u5668${where}\u62d2\u7edd\u4e86\u8fde\u63a5\uff1a\u8fd9\u4e2a\u7aef\u53e3\u4e0a\u6ca1\u6709\u7a0b\u5e8f\u5728\u76d1\u542c\u3002` +
      `\u8bf7\u786e\u8ba4 frps \u5df2\u542f\u52a8\u3001bindPort \u4e0e\u8fd9\u91cc\u586b\u7684\u7aef\u53e3\u4e00\u81f4\uff0c\u6216\u670d\u52a1\u5668\u9632\u706b\u5899\u6ca1\u6709\u62d2\u7edd\u8fd9\u4e2a\u7aef\u53e3\u3002`
    );
  }
  return null;
}

function firstMatch(line: string, pattern: RegExp): string | null {
  return line.match(pattern)?.[0] ?? null;
}

function jsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ngrokUrl(line: string): string | null {
  const record = jsonLine(line);
  if (record) {
    // The named field only. ngrok's own failures quote URLs — the authtoken page is one
    // of them — so a pattern loose enough to accept a reserved domain would read the
    // link out of an error and report it as the tunnel that did not start.
    const url = record.url;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  }
  // logfmt, from a build that ignored `--log-format=json`: keyed on `url=` for the same
  // reason, since that line carries the addr and the dashboard link too.
  return line.match(/\burl=(https:\/\/[^\s"]+)/i)?.[1] ?? null;
}

/**
 * ngrok refusing to authenticate, which is the first wall almost everybody hits.
 *
 * Matched on ngrok's own error codes first — `ERR_NGROK_4018` is "requires a verified
 * account and authtoken", `105`/`107`/`108` are a token that is malformed, unknown or
 * already in use elsewhere — and on the prose as a fallback, because the codes are the
 * part of the message ngrok has kept stable and the wording is not.
 *
 * Deliberately narrow. Anything matched here *stops the run*, so a pattern that also
 * caught a transient network error would turn a tunnel that was about to come up into a
 * failure telling the user to go fix their account.
 */
function ngrokFatal(line: string): Failure | null {
  const record = jsonLine(line);
  const detail = typeof record?.err === "string" ? record.err : "";
  const haystack = `${detail} ${line}`;
  if (!/\bERR_NGROK_(?:4018|105|107|108)\b|authentication failed|requires a verified account|authtoken/i.test(haystack)) {
    return null;
  }
  return {
    message: "ngrok \u8ba4\u8bc1\u5931\u8d25\uff1a\u8fd8\u6ca1\u6709\u914d\u7f6e\u53ef\u7528\u7684 authtoken",
    needsAuth: true,
  };
}

/**
 * Whether an ngrok authtoken is on this machine.
 *
 * Read from the files and the environment rather than asked of the binary: `ngrok config
 * check` only validates the file's *syntax* and answers "valid" for a config with no
 * token in it at all, and there is no stable subcommand that prints whether one is set.
 * Inspecting the two places ngrok itself reads is the question actually being asked.
 *
 * Returns `null` — not `false` — when a file exists and cannot be read, because the only
 * thing `false` is used for is to stop a run before it starts, and a permissions error
 * is not evidence that the user has not configured anything.
 */
function ngrokAuthtoken(): boolean | null {
  // `NGROK_AUTHTOKEN` wins over the config file in the agent itself, so it is the first
  // thing to look at. A token here means the tunnel runs even with no config at all.
  for (const name of ["NGROK_AUTHTOKEN", "NGROK_AUTH_TOKEN"]) {
    if ((process.env[name] ?? "").trim()) return true;
  }
  let unreadable = false;
  let found = false;
  for (const file of ngrokConfigFiles()) {
    let text: string;
    try {
      if (!existsSync(file)) continue;
      text = readFileSync(file, "utf8");
    } catch {
      unreadable = true;
      continue;
    }
    found = true;
    if (authtokenInConfig(text)) return true;
  }
  // A config that exists without a token, or no config anywhere, both mean the same
  // thing and are both certain. Only an unreadable file leaves the question open.
  return unreadable && !found ? null : false;
}

/**
 * Whether an ngrok config file actually carries a token.
 *
 * One pattern for both layouts ngrok accepts: a top-level `authtoken:` (v2, and what
 * plenty of upgraded installs still have) and the `agent:`-nested one of a version-3
 * config. Requiring something after the colon is the point — a key with an empty value
 * is what a half-finished `ngrok config edit` leaves behind, and it authenticates
 * nothing.
 *
 * Exported for its test: this is the one part of the detection that is parsing rather
 * than looking, so it is the part that can be wrong while looking right.
 */
export function authtokenInConfig(text: string): boolean {
  return /^[ \t]*authtoken:[ \t]*\S+/m.test(text);
}

/**
 * Where ngrok keeps its config, in the order it reads them.
 *
 * `ngrok config add-authtoken` writes the platform path; `~/.ngrok2/ngrok.yml` is the v2
 * location, which v3 still honours and which plenty of machines still have.
 */
function ngrokConfigFiles(): string[] {
  const home = homedir();
  const legacy = join(home, ".ngrok2", "ngrok.yml");
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "ngrok", "ngrok.yml"), legacy];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(local, "ngrok", "ngrok.yml"), legacy];
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(config, "ngrok", "ngrok.yml"), legacy];
}

function ngrokProblem(line: string): string | null {
  const record = jsonLine(line);
  if (!record) return /\b(?:err|error|failed)\b/i.test(line) ? line : null;
  const level = typeof record.lvl === "string" ? record.lvl : "";
  const message = typeof record.msg === "string" ? record.msg : "";
  const detail = typeof record.err === "string" ? record.err : "";
  // `eror` is not a typo here: it is how ngrok spells the level, padded to four columns.
  if (!detail && !/^(?:eror|error|crit)$/i.test(level)) return null;
  return [message, detail].filter(Boolean).join(": ") || null;
}

export type TunnelDeps = {
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
  };
  /** Told about every phase change, so the settings pane follows along live. */
  onChange?: () => void;
  /** Only tests pass this: waiting out the real one is a minute per case. */
  startTimeoutMs?: number;
  /**
   * Start the tool. Overridden by tests, which stand a script in for the binary.
   *
   * Returning the child rather than taking a command line keeps the seam at the process
   * boundary: everything above it — the URL patterns, the phases, the timeout, the tail
   * of output — is the code that actually has bugs, and it is the same code in a test as
   * in the app.
   */
  launch?: (provider: TunnelProvider, port: number, options: TunnelOptions) => ChildProcess;
  /**
   * Answer the credential question instead of inspecting this machine.
   *
   * The other half of the `launch` seam, and needed for the same reason: a test that
   * stands a script in for the binary would otherwise still be refused before the spawn
   * by a real ngrok config check — and would pass or fail depending on whether the
   * machine running it happens to have an authtoken, which is a test that reports on
   * the wrong thing.
   */
  credential?: (provider: TunnelProvider) => boolean | null;
};

export class TunnelRunner {
  #deps: TunnelDeps;
  #child: ChildProcess | null = null;
  #status: TunnelStatus = TUNNEL_OFF;
  #timer: NodeJS.Timeout | null = null;
  /**
   * Which run the handlers below belong to.
   *
   * A tunnel is stopped in four ways — the user flips the switch, the server stops, the
   * URL never arrives, the app quits — and each of them races the child's own `exit`,
   * which arrives after the decision was already made. Bumping this on every start and
   * stop, and having each listener check the number it captured, is what keeps a dying
   * process from overwriting the status of the one that replaced it: without it, turning
   * the tunnel off and straight back on reported 「隧道已断开」 over a tunnel that was
   * at that moment coming up.
   */
  #run = 0;
  /** Resolved once the tool prints a URL, or fails. One `start()` awaits one of these. */
  #settle: ((status: TunnelStatus) => void) | null = null;

  constructor(deps: TunnelDeps) {
    this.#deps = deps;
  }

  get status(): TunnelStatus {
    return this.#status;
  }

  get url(): string | null {
    return this.#status.url;
  }

  /**
   * Run a tunnel in front of `port`.
   *
   * Never rejects. The caller is either a settings pane that has a place to show
   * `status.error`, or the app's own restore path, where a tunnel that cannot start must
   * not be the reason the window does not open — and in both cases the failure belongs
   * in the pushed status next to the phase, not in a rejected promise that only one of
   * the two callers is in a position to catch.
   */
  async start(provider: TunnelProvider, port: number, options: TunnelOptions = {}): Promise<TunnelStatus> {
    await this.stop();
    const spec = PROVIDERS[provider];
    const run = ++this.#run;
    this.#set({ provider, phase: "starting", url: null, error: null, output: [], needsAuth: false });

    const unconfigured = spec.unconfigured?.(options) ?? null;
    if (unconfigured) return this.#fail(run, unconfigured);

    /*
     * Refuse before spawning, when the tool already tells us it cannot work.
     *
     * The case is ngrok with no authtoken: it starts, logs a refusal, and reconnects
     * forever, so what the user got for pressing 确认 was a minute of 启动中… followed
     * by a timeout that blamed the clock. Checking the credential first turns that into
     * one sentence and the command that fixes it, immediately. `null` from `present()`
     * means the question could not be answered, and an unanswered question is not
     * grounds to stop anybody — only a definite `false` is.
     */
    if (spec.credential) {
      // Which function answers is decided by whether the dep *exists*, not by what it
      // returned. `??` here read a deliberate `null` — "cannot tell" — as no answer at
      // all and fell through to the real check, which is the one outcome that must not
      // stop a run: an unreadable config file is not evidence of an unconfigured one.
      const present = this.#deps.credential
        ? this.#deps.credential(provider)
        : spec.credential.present();
      if (present === false) return this.#fail(run, spec.credential.missing, true);
    }

    let child: ChildProcess;
    try {
      child = this.#deps.launch
        ? this.#deps.launch(provider, port, options)
        : spawn(resolveOrThrow(spec.command), spec.args(port, options), {
            stdio: ["ignore", "pipe", "pipe"],
            // No shell: the port is the only thing interpolated and it is a number, but
            // a shell here would also mean the user's rc files decide what runs.
            shell: false,
          });
    } catch (error) {
      return this.#fail(run, cleanMessage(error));
    }

    this.#child = child;
    const done = new Promise<TunnelStatus>((settle) => {
      this.#settle = settle;
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const read = (chunk: string): void => this.#consume(run, spec, options, String(chunk));
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);

    child.on("error", (error) => {
      // `spawn` reports a missing or non-executable binary here rather than throwing,
      // so this is the path a broken install actually takes.
      this.#fail(run, cleanMessage(error));
    });

    child.on("exit", (code, signal) => {
      if (run !== this.#run) return;
      this.#child = null;
      // An exit whose output already said the credential was refused is that failure,
      // not a generic one: a version of the tool that exits instead of reconnecting
      // must reach the same control in the pane as one that does.
      const refused = this.#lastFatal(spec);
      if (refused) {
        this.#fail(run, refused.message, refused.needsAuth);
        return;
      }
      const how = signal ? `\u4fe1\u53f7 ${signal}` : `\u9000\u51fa\u7801 ${code ?? 0}`;
      const quoted = this.#lastProblem(spec);
      const detail = quoted ? `\uff1a${quoted}` : "";
      this.#fail(
        run,
        this.#status.url
          ? `\u96a7\u9053\u5df2\u65ad\u5f00\uff08${how}\uff09${detail}`
          : `${spec.command} \u542f\u52a8\u5931\u8d25\uff08${how}\uff09${detail}`,
      );
    });

    const timeout = this.#deps.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#timer = setTimeout(() => {
      this.#deps.log.warn(`tunnel ${provider} printed no url in ${timeout}ms`);
      // The reason is recorded before the kill, not after: the kill provokes an `exit`
      // that would otherwise arrive with its own sentence about a signal, and bury the
      // one that actually explains what happened. Retiring the run right after is what
      // makes that exit silent.
      this.#fail(run, `${spec.command} \u5728 ${Math.round(timeout / 1000)} \u79d2\u5185\u6ca1\u6709\u8fd4\u56de\u516c\u7f51\u5730\u5740`);
      this.#run += 1;
      this.#child = null;
      killChild(child);
    }, timeout);
    this.#timer.unref();

    return done;
  }

  async stop(): Promise<TunnelStatus> {
    this.#clearTimer();
    const child = this.#child;
    this.#child = null;
    // Every listener of the run being torn down is now stale, including the `exit` the
    // kill below is about to cause.
    this.#run += 1;
    // Anything awaiting `start()` is answered with the state as it stands rather than
    // left hanging on a process that is going away.
    this.#resolve(this.#status);
    if (!child) {
      if (this.#status.phase !== "off") this.#set(TUNNEL_OFF);
      return this.#status;
    }
    await new Promise<void>((settle) => {
      const kill = setTimeout(() => {
        // SIGTERM ignored or the process wedged: it is a tunnel, there is nothing to
        // flush, and leaving it alive would hold the publication of the port open.
        killChild(child, "SIGKILL");
        settle();
      }, KILL_GRACE_MS);
      kill.unref();
      child.once("exit", () => {
        clearTimeout(kill);
        settle();
      });
      if (!killChild(child)) {
        clearTimeout(kill);
        settle();
      }
    });
    this.#set(TUNNEL_OFF);
    this.#deps.log.info("tunnel stopped");
    return this.#status;
  }

  // ---------------------------------------------------------------- internals

  #consume(run: number, spec: ProviderSpec, options: TunnelOptions, chunk: string): void {
    if (run !== this.#run) return;
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return;
    const output = [...this.#status.output, ...lines.map((line) => line.slice(0, OUTPUT_LINE_CHARS))].slice(
      -OUTPUT_LINES,
    );
    let url: string | null = null;
    let fatal: Failure | null = null;
    for (const line of lines) {
      url = spec.url(line, options) ?? url;
      fatal = fatal ?? spec.fatal?.(line) ?? null;
    }

    // A refusal the tool will not recover from. Recorded with the output that explains
    // it, then the process is retired — it would otherwise keep reconnecting behind a
    // pane that has already given the user the answer.
    if (fatal && this.#status.phase !== "error") {
      this.#status = { ...this.#status, output };
      const child = this.#child;
      this.#fail(run, fatal.message, fatal.needsAuth);
      this.#run += 1;
      this.#child = null;
      if (child) killChild(child);
      return;
    }

    if (url && url !== this.#status.url) {
      this.#clearTimer();
      this.#deps.log.info(`tunnel online at ${url}`);
      this.#set({ ...this.#status, phase: "online", url, error: null, output });
      this.#resolve(this.#status);
      return;
    }
    // Output alone is not announced. Both tools narrate their startup over a dozen
    // lines, and each one would otherwise be a broadcast to every window for a string
    // nothing renders until something goes wrong — at which point `#fail` sends the
    // whole tail along with the reason.
    this.#status = { ...this.#status, output };
  }

  /** A refusal anywhere in the tail, for an exit that happened before `#consume` saw it. */
  #lastFatal(spec: ProviderSpec): Failure | null {
    if (!spec.fatal) return null;
    for (const line of [...this.#status.output].reverse()) {
      const fatal = spec.fatal(line);
      if (fatal) return fatal;
    }
    return null;
  }

  /** The most recent line the tool itself flagged as a problem. */
  #lastProblem(spec: ProviderSpec): string | null {
    for (const line of [...this.#status.output].reverse()) {
      const problem = spec.problem(line);
      if (problem) return problem.trim();
    }
    return null;
  }

  #fail(run: number, error: string, needsAuth = false): TunnelStatus {
    // A process that is already being replaced has nothing to say. `stop()` and the
    // timeout both retire the run before anything of theirs can land here.
    if (run !== this.#run) return this.#status;
    this.#clearTimer();
    this.#deps.log.warn(`tunnel failed: ${error}`);
    this.#set({ ...this.#status, phase: "error", url: null, error, needsAuth });
    this.#resolve(this.#status);
    return this.#status;
  }

  #set(status: TunnelStatus): void {
    this.#status = status;
    this.#deps.onChange?.();
  }

  #resolve(status: TunnelStatus): void {
    const settle = this.#settle;
    this.#settle = null;
    settle?.(status);
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** Signal a child, reporting whether there was anything left to signal. */
function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    return child.kill(signal);
  } catch {
    // Already reaped between the decision and here.
    return false;
  }
}

function resolveOrThrow(command: string): string {
  const found = findExecutable(command);
  if (!found) throw new Error(`未找到 ${command} 命令，请先安装并确认它在 PATH 中`);
  return found;
}

function cleanMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "").trim() || "未知错误";
}

/**
 * Where a command is, searching PATH the way a shell would.
 *
 * `spawn` can find it on its own; this exists because the pane has to say whether a
 * tool is installed *before* anything is run, and "installed" is exactly "on PATH".
 * `applyShellPath()` has already put Homebrew and the user bins onto `process.env.PATH`
 * by the time this runs, which is what makes a GUI-launched Electron see a `brew
 * install cloudflared` at all.
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const dirs = (env[key] ?? "").split(delimiter).filter(Boolean);
  // On Windows the name on PATH is `cloudflared.exe` (or a `.cmd` shim), and PATHEXT is
  // the list the shell itself would try.
  const suffixes =
    platform === "win32"
      ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""]
      : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // An unreadable PATH entry is not an answer; keep looking.
      }
    }
  }
  return null;
}

/**
 * Which tunnels this machine can run, for the setup guidance in the settings pane.
 *
 * `--version` is run rather than trusting the file's existence: a half-finished install,
 * a shim pointing at a deleted binary, or a macOS quarantine flag all leave something on
 * PATH that cannot execute, and finding that out at `--version` is a sentence in the
 * pane instead of a mystery when the switch is flipped.
 */
export async function probeTunnelTools(): Promise<TunnelTools> {
  const entries = await Promise.all(
    TUNNEL_PROVIDERS.map(async (provider) => [provider, await probeOne(provider)] as const),
  );
  return Object.fromEntries(entries) as TunnelTools;
}

async function probeOne(provider: TunnelProvider): Promise<TunnelToolInfo> {
  const spec = PROVIDERS[provider];
  const command = spec.command;
  // The same function the start path enforces with, so the pane cannot offer a provider
  // that `start()` is about to refuse, or warn about one it would have run.
  const authenticated = spec.credential ? spec.credential.present() : null;
  const path = findExecutable(command);
  if (!path) return { installed: false, path: null, version: null, authenticated };
  const version = await new Promise<string | null>((settle) => {
    execFile(path, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        settle(null);
        return;
      }
      const line = `${stdout}\n${stderr}`
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
      settle(line ? line.slice(0, 120) : "");
    });
  });
  // A binary that is there but will not run is not one the pane should offer.
  return version === null
    ? { installed: false, path, version: null, authenticated }
    : { installed: true, path, version, authenticated };
}
