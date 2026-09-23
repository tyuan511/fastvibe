/**
 * A self-hosted frp tunnel: the user's own `frps`, dialled by `frpc`.
 *
 * cloudflared and ngrok are somebody else's servers, and each has the same two costs: a
 * quick tunnel's hostname changes every run (so the phone's bookmark dies with it), and
 * ngrok needs an account. A user with a VPS already has what frp needs — a public address
 * — and gets a URL that never changes.
 *
 * What makes frp different from the other two is that it never tells us the public URL.
 * `frpc` only says a proxy was registered; the address it is reachable at depends on how
 * the *server* was set up (`vhostHTTPPort`, a domain's DNS, an nginx doing TLS in front),
 * none of which the client can see. So the URL is derived from what the user typed, and
 * the user can override it — which is also how HTTPS in front of frps is expressed.
 *
 * Shared and dependency-free: Main renders the config and enforces the rules, the
 * settings pane validates as the user types and previews the URL, and the tests read the
 * same functions. Two copies of "is this a valid domain" would disagree the day one of
 * them is edited, and the pane would accept a form Main then refuses.
 */

/**
 * How the local server is published.
 *
 * `http` routes by domain through frps's `vhostHTTPPort`, which is what lets one frps
 * serve many clients on port 80 — and is the only mode where a TLS reverse proxy in front
 * of frps can give the phone an `https://` URL. `tcp` claims a port on the server and
 * needs nothing else: no domain, no DNS, and plain `http://` to an IP.
 */
export type FrpMode = "http" | "tcp";

export type FrpConfig = {
  serverAddr: string;
  serverPort: number;
  /** `auth.token`, when frps sets one. Main only; never sent to a renderer. */
  token: string;
  mode: FrpMode;
  /** `http`: the domain (`customDomains`) this machine is routed by. */
  domain: string;
  /** `http`: the server's `vhostHTTPPort`, used only to derive the URL. 80 when empty. */
  vhostPort: number | null;
  /** `tcp`: the port claimed on the server (`remotePort`). */
  remotePort: number | null;
  /** The address a phone actually opens, when it is not the derived one. */
  publicUrl: string;
  /**
   * The proxy's name on frps, which must be unique across every client of that server.
   *
   * Minted once and kept, rather than a constant: two FastVibe installs on one frps
   * would otherwise refuse each other with `proxy already exists`, and a name that
   * changed per run would leave the previous registration to linger until it timed out.
   */
  proxyName: string;
};

/** The config as a renderer sees it: everything but the token, and whether there is one. */
export type FrpSettingsView = Omit<FrpConfig, "token"> & { hasToken: boolean };

/**
 * A save from the pane.
 *
 * `token` is three-valued on purpose, the same shape the SSH password takes: absent keeps
 * the stored one (the pane never has it to send back), a string replaces it, and `""`
 * clears it. Without the "absent" case, every unrelated edit would wipe the token.
 */
export type FrpSettingsInput = Omit<FrpConfig, "token" | "proxyName"> & { token?: string };

export const FRP_DEFAULT_SERVER_PORT = 7000;

export const FRP_EMPTY: Omit<FrpConfig, "proxyName"> = {
  serverAddr: "",
  serverPort: FRP_DEFAULT_SERVER_PORT,
  token: "",
  mode: "http",
  domain: "",
  vhostPort: null,
  remotePort: null,
  publicUrl: "",
};

/** Which field is wrong, so the pane can put the message under that field. */
export type FrpProblem = {
  field: "serverAddr" | "serverPort" | "domain" | "vhostPort" | "remotePort" | "publicUrl";
  message: string;
};

/**
 * A hostname or an IP. Deliberately strict: whatever passes is interpolated into a TOML
 * file and a URL, so a quote, a space or a slash here is a broken config at best.
 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV6 = /^[0-9a-f:.]+$/i;

function validHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return HOST.test(value) || (value.includes(":") && IPV6.test(value));
}

/** A domain `customDomains` can route by: a hostname, never an IP literal. */
export function isFrpDomain(value: string): boolean {
  return validHost(value) && !value.includes(":") && !/^[\d.]+$/.test(value);
}

/** A hostname or an IP, as `serverAddr` accepts. */
export function isFrpHost(value: string): boolean {
  return validHost(value);
}

function validPort(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;
}

/** Every problem with a config, in form order. Empty means it can be run. */
export function frpProblems(config: Omit<FrpConfig, "token" | "proxyName">): FrpProblem[] {
  const problems: FrpProblem[] = [];
  if (!validHost(config.serverAddr.trim())) {
    problems.push({ field: "serverAddr", message: "请填写有效的服务器地址（域名或 IP）" });
  }
  if (!validPort(config.serverPort)) {
    problems.push({ field: "serverPort", message: "端口需在 1–65535 之间" });
  }
  if (config.mode === "http") {
    const domain = config.domain.trim();
    // An IP is not a domain here: frps routes `http` by the Host header, and a bare IP
    // Host only reaches this proxy if nothing else on that frps claimed it first.
    if (!validHost(domain) || domain.includes(":")) {
      problems.push({ field: "domain", message: "请填写解析到 frps 的域名" });
    }
    if (config.vhostPort !== null && !validPort(config.vhostPort)) {
      problems.push({ field: "vhostPort", message: "端口需在 1–65535 之间" });
    }
  } else if (!validPort(config.remotePort)) {
    problems.push({ field: "remotePort", message: "请填写 frps 上要占用的端口" });
  }
  const url = config.publicUrl.trim();
  if (url && !parseHttpUrl(url)) {
    problems.push({ field: "publicUrl", message: "请填写 http:// 或 https:// 开头的地址" });
  }
  return problems;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The address a phone opens.
 *
 * The override wins, stripped of a trailing slash so it reads like the derived one.
 * Otherwise `http` is the domain on frps's vhost port and `tcp` is the server on the
 * claimed port — both plain `http://`, because frps serving HTTPS itself would need the
 * certificate on *this* machine, and the common setup puts TLS in a proxy in front of
 * frps instead, which is exactly what the override expresses.
 */
export function frpPublicUrl(config: Omit<FrpConfig, "token" | "proxyName">): string | null {
  const override = parseHttpUrl(config.publicUrl.trim());
  if (override) return override.href.replace(/\/$/, "");
  if (config.mode === "http") {
    const domain = config.domain.trim();
    if (!domain) return null;
    const port = config.vhostPort && config.vhostPort !== 80 ? `:${config.vhostPort}` : "";
    return `http://${domain}${port}`;
  }
  const host = config.serverAddr.trim();
  if (!host || !validPort(config.remotePort)) return null;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.remotePort}`;
}

/**
 * A TOML basic string.
 *
 * JSON's escapes are a subset TOML accepts (`\"`, `\\`, `\n`, `\uXXXX`), so this is
 * exact for any string, including a token with a quote in it.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The `frpc.toml` that publishes `localPort`.
 *
 * TOML, so frp 0.52 or newer — the INI format older releases read is deprecated and
 * spelled differently. Three settings are not frp's defaults and each is load-bearing:
 *
 * - `loginFailExit = true`: a refused token then *exits* rather than retrying forever,
 *   which is what turns a wrong token into a sentence in the pane instead of a minute of
 *   启动中… and a timeout.
 * - `log.disablePrintColor`: the output is piped, not drawn, and the tail is shown to
 *   the user verbatim.
 * - `localIP = "127.0.0.1"`: the server binds loopback only, and frp's default resolves
 *   `localhost`, which can be `::1` first.
 */
export function renderFrpcToml(config: FrpConfig, localPort: number): string {
  const lines = [
    "# Written by FastVibe for 远程访问 → 内网穿透. Rewritten on every start.",
    `serverAddr = ${tomlString(config.serverAddr.trim())}`,
    `serverPort = ${config.serverPort}`,
    "loginFailExit = true",
    'log.to = "console"',
    'log.level = "info"',
    "log.disablePrintColor = true",
  ];
  if (config.token) {
    lines.push('auth.method = "token"', `auth.token = ${tomlString(config.token)}`);
  }
  lines.push(
    "",
    "[[proxies]]",
    `name = ${tomlString(config.proxyName)}`,
    `type = ${tomlString(config.mode)}`,
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
  );
  if (config.mode === "http") {
    lines.push(`customDomains = [${tomlString(config.domain.trim())}]`);
  } else {
    lines.push(`remotePort = ${config.remotePort}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Normalise whatever was on disk (or sent by the pane) into a config, or null. */
export function readFrpConfig(value: unknown): FrpConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const port = (key: string): number | null => {
    const raw = record[key];
    return typeof raw === "number" && validPort(raw) ? raw : null;
  };
  const proxyName = text("proxyName");
  if (!/^[\w.-]{1,64}$/.test(proxyName)) return null;
  return {
    serverAddr: text("serverAddr").trim(),
    serverPort: port("serverPort") ?? FRP_DEFAULT_SERVER_PORT,
    token: text("token"),
    mode: record.mode === "tcp" ? "tcp" : "http",
    domain: text("domain").trim(),
    vhostPort: port("vhostPort"),
    remotePort: port("remotePort"),
    publicUrl: text("publicUrl").trim(),
    proxyName,
  };
}

/** What a renderer may see. */
export function frpView(config: FrpConfig | null): FrpSettingsView | null {
  if (!config) return null;
  const { token, ...rest } = config;
  return { ...rest, hasToken: token.length > 0 };
}

/**
 * Where a domain points, compared with where the frps server is.
 *
 * HTTP mode routes by domain, so the domain has to resolve to the frps machine before a
 * phone can reach anything — and a domain that points somewhere else (or nowhere yet)
 * is the most common way this setup fails. frpc cannot notice: it registers the proxy
 * happily and reports success, and the phone then gets a DNS error or somebody else's
 * site. So the pane looks the domain up while the user is still typing it.
 *
 * - `match`: at least one address in common with the server.
 * - `mismatch`: resolves, but not to the server. Not necessarily wrong — a CDN in front
 *   (Cloudflare's proxied records) answers with its own addresses — so it is a warning.
 * - `unresolved`: no record yet, or not propagated.
 * - `resolved`: resolves, and the server address could not be looked up to compare.
 */
export type FrpDnsVerdict = "match" | "mismatch" | "unresolved" | "resolved";

export type FrpDnsCheck = {
  domain: string;
  verdict: FrpDnsVerdict;
  /** What the domain resolved to, IPv4 first. */
  domainAddresses: string[];
  /** What the server address resolved to (itself, when it is an IP). */
  serverAddresses: string[];
};

export function frpDnsVerdict(domainAddresses: readonly string[], serverAddresses: readonly string[]): FrpDnsVerdict {
  if (domainAddresses.length === 0) return "unresolved";
  if (serverAddresses.length === 0) return "resolved";
  const server = new Set(serverAddresses.map((address) => address.toLowerCase()));
  return domainAddresses.some((address) => server.has(address.toLowerCase())) ? "match" : "mismatch";
}
