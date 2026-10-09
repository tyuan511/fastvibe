#!/usr/bin/env node
/**
 * `pnpm dev:web`: the cloud service and the website, together, with one Ctrl+C for both.
 *
 *   server  make -C services/cloud run     Postgres (compose) + the Go service
 *   web     next dev --port <n>            the site, with /api proxied to the service
 *
 * Settings come from services/cloud/.env.local (git-ignored). The website's port is the
 * one in FASTVIBE_PUBLIC_ORIGIN and the proxy target follows FASTVIBE_HTTP__LISTEN, so the
 * two halves cannot disagree. Needs Docker, Go, make and a POSIX shell. Postgres is left
 * running when this exits (`make -C services/cloud down` stops it).
 */
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { concurrently } from "concurrently";
import { parseEnvFile, resolveDevWeb } from "./lib/dev-web-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, "services", "cloud", ".env.local");

/** True if something already accepts connections on this port, on either loopback family. */
function inUse(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host, timeout: 500 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((answers) => answers.some(Boolean));
}

function fail(message) {
  console.error(`dev:web: ${message}`);
  process.exit(1);
}

let config;
try {
  const fileEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  config = resolveDevWeb({ fileEnv, env: process.env });
} catch (error) {
  fail(error.message);
}

for (const [what, port] of [["the website", config.webPort], ["the cloud service", config.cloudPort]]) {
  if (await inUse(port)) {
    fail(
      `port ${port} (${what}) is already in use. Stop whatever is on it, or pick another port: ` +
        "the website's comes from FASTVIBE_PUBLIC_ORIGIN and the service's from FASTVIBE_HTTP__LISTEN " +
        "in services/cloud/.env.local (and the GitHub OAuth App's callback URL must follow the origin).",
    );
  }
}

console.log(`
  site     ${config.siteOrigin}/login
  api      ${config.cloudOrigin}  (reached through the site at /api)
  config   ${existsSync(envFile) ? "services/cloud/.env.local" : "no services/cloud/.env.local: defaults"}
${config.githubConfigured ? "" : "  note     GitHub sign-in is not configured; set FASTVIBE_GITHUB__CLIENT_ID and _CLIENT_SECRET in .env.local\n"}`);

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; });

const { result } = concurrently(
  [
    { name: "server", command: "make -C services/cloud run", cwd: root, prefixColor: "cyan" },
    {
      name: "web",
      command: `pnpm --filter @fastvibe/website exec next dev --port ${config.webPort}`,
      cwd: root,
      prefixColor: "magenta",
      env: { CLOUD_API_ORIGIN: config.cloudOrigin },
    },
  ],
  {
    prefix: "[{name}]",
    // Half a stack is worse than none: if either side stops, stop the other.
    killOthersOn: ["failure", "success"],
    restartTries: 0,
    handleInput: false,
  },
);

try {
  await result;
} catch {
  // A Ctrl+C ends both processes with a signal, which is the normal way out, not a failure.
  process.exitCode = interrupted ? 0 : 1;
}
