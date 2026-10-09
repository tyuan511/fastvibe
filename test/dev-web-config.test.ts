import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, resolveDevWeb } from "../scripts/lib/dev-web-config.mjs";

/**
 * `pnpm dev:web` starts the website on the port written in FASTVIBE_PUBLIC_ORIGIN and
 * points its /api proxy at wherever the service listens. Both numbers come from the one
 * file the service reads, so what is pinned here is that they are read the way `make run`
 * reads them — the file over the shell, the shell over the defaults — because a website
 * on the wrong port signs nobody in (the Origin check and the OAuth callback both fail).
 */

test("an env file is read the way sh would read the simple cases", () => {
  const env = parseEnvFile(`
# a comment
FASTVIBE_GITHUB__CLIENT_ID=abc123
export FASTVIBE_GITHUB__CLIENT_SECRET="se cret=with#chars"
FASTVIBE_PUBLIC_ORIGIN='http://localhost:3010'
FASTVIBE_ADMIN__GITHUB_IDS=583231   # me
  SPACED = ignored because sh would not accept spaces around =
not a line
EMPTY=
`);
  assert.deepEqual(env, {
    FASTVIBE_GITHUB__CLIENT_ID: "abc123",
    FASTVIBE_GITHUB__CLIENT_SECRET: "se cret=with#chars",
    FASTVIBE_PUBLIC_ORIGIN: "http://localhost:3010",
    FASTVIBE_ADMIN__GITHUB_IDS: "583231",
    EMPTY: "",
  });
});

test("defaults match what make run uses", () => {
  assert.deepEqual(resolveDevWeb(), {
    siteOrigin: "http://localhost:9088",
    webPort: 9088,
    cloudOrigin: "http://127.0.0.1:9089",
    cloudPort: 9089,
    githubConfigured: false,
  });
});

test("the file wins over the environment, which wins over the defaults", () => {
  const got = resolveDevWeb({
    fileEnv: { FASTVIBE_PUBLIC_ORIGIN: "http://localhost:3010/" },
    env: { FASTVIBE_PUBLIC_ORIGIN: "http://localhost:4000", FASTVIBE_HTTP__LISTEN: "127.0.0.1:19090" },
  });
  assert.equal(got.siteOrigin, "http://localhost:3010");
  assert.equal(got.webPort, 3010);
  assert.equal(got.cloudOrigin, "http://127.0.0.1:19090");
});

test("a wildcard listen address is reached through loopback", () => {
  for (const listen of [":9089", "0.0.0.0:9089", "[::]:9089"]) {
    assert.equal(resolveDevWeb({ env: { FASTVIBE_HTTP__LISTEN: listen } }).cloudOrigin, "http://127.0.0.1:9089", listen);
  }
  assert.equal(resolveDevWeb({ env: { FASTVIBE_HTTP__LISTEN: "10.1.2.3:9089" } }).cloudOrigin, "http://10.1.2.3:9089");
});

test("GitHub counts as configured only with both halves", () => {
  const configured = (env: Record<string, string>) => resolveDevWeb({ env }).githubConfigured;
  assert.equal(configured({ FASTVIBE_GITHUB__CLIENT_ID: "id" }), false);
  assert.equal(configured({ FASTVIBE_GITHUB__CLIENT_SECRET: "s" }), false);
  assert.equal(configured({ FASTVIBE_GITHUB__CLIENT_ID: "id", FASTVIBE_GITHUB__CLIENT_SECRET: "s" }), true);
});

test("an origin dev:web cannot serve is refused with what to do", () => {
  const origin = (value: string) => () => resolveDevWeb({ env: { FASTVIBE_PUBLIC_ORIGIN: value } });
  assert.throws(origin("https://app.fastvibe.dev"), /http:\/\/localhost:<port>/);
  assert.throws(origin("http://192.168.1.5:9088"), /http:\/\/localhost:<port>/);
  assert.throws(origin("http://localhost"), /explicit port/);
  assert.throws(origin("not a url"), /not a URL/);
  assert.throws(() => resolveDevWeb({ env: { FASTVIBE_HTTP__LISTEN: "nonsense" } }), /host:port/);
  assert.doesNotThrow(origin("http://127.0.0.1:3010"));
});
