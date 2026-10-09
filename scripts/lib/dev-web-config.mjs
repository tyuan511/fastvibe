/**
 * What `pnpm dev:web` needs to know before it starts anything: which port the website
 * takes and where the cloud API is, both worked out from the one place they are already
 * written down, services/cloud/.env.local. The site's port is the port in
 * FASTVIBE_PUBLIC_ORIGIN, because that origin is what the service compares every request's
 * Origin header with and what the GitHub OAuth App's callback URL is registered against:
 * a website on any other port signs nobody in.
 */

/** KEY=VALUE lines, as `sh` would read them for the simple cases: comments, `export`, quotes. */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, ""); // a trailing comment on an unquoted value
    env[match[1]] = value;
  }
  return env;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `fileEnv` wins over `env`, which wins over the defaults: the order `make run` applies,
 * since it sources the file over whatever the shell had.
 */
export function resolveDevWeb({ fileEnv = {}, env = {} } = {}) {
  const setting = (key, fallback) => fileEnv[key] ?? env[key] ?? fallback;

  const origin = setting("FASTVIBE_PUBLIC_ORIGIN", "http://localhost:9088").replace(/\/+$/, "");
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`FASTVIBE_PUBLIC_ORIGIN is not a URL: ${origin}`);
  }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `dev:web serves the website on this machine over http, but FASTVIBE_PUBLIC_ORIGIN is ${origin}. ` +
        "Set it to http://localhost:<port> in services/cloud/.env.local.",
    );
  }
  if (!url.port) {
    throw new Error(`FASTVIBE_PUBLIC_ORIGIN needs an explicit port (http://localhost:9088), got ${origin}`);
  }

  const listen = setting("FASTVIBE_HTTP__LISTEN", "127.0.0.1:9089");
  const listenMatch = /^(.*):(\d+)$/.exec(listen);
  if (!listenMatch) throw new Error(`FASTVIBE_HTTP__LISTEN must look like host:port, got ${listen}`);
  const wildcard = new Set(["", "0.0.0.0", "[::]", "::"]);
  const apiHost = wildcard.has(listenMatch[1]) ? "127.0.0.1" : listenMatch[1];

  return {
    siteOrigin: origin,
    webPort: Number(url.port),
    cloudOrigin: `http://${apiHost}:${listenMatch[2]}`,
    cloudPort: Number(listenMatch[2]),
    githubConfigured: Boolean(
      setting("FASTVIBE_GITHUB__CLIENT_ID", "") && setting("FASTVIBE_GITHUB__CLIENT_SECRET", ""),
    ),
  };
}
