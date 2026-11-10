// SPDX-License-Identifier: MIT
// Child exits after the remote HTTP mutation, before its SQLite receipt commit.
import { GithubOperationHttpAdapter } from "../../src/main/bot/shadow/github-deployment.ts";
import { ShadowCredentialHost } from "../../src/main/bot/shadow/credential-host.ts";
import { ShadowSourceRegistry } from "../../src/main/bot/shadow/source-registry.ts";
import { ShadowEffects } from "../../src/main/bot/shadow/effects.ts";
import { ShadowOperations } from "../../src/main/bot/shadow/operations.ts";
import { openShadowStore } from "../../src/main/bot/shadow/store.ts";

const [file, origin] = process.argv.slice(2);
if (!file || !origin) throw new Error("missing fixture arguments");
const store = openShadowStore(file); const registry = new ShadowSourceRegistry(store);
const credentials = new ShadowCredentialHost(registry);
credentials.register({ id: "m11.fake", kind: "github" }, { resolve: async () => "loopback-only-secret" });
const adapter = new GithubOperationHttpAdapter({ baseUrl: origin, credentials });
const effects = new ShadowEffects(store, { now: () => 1000, owner: "crashed-http-child", leaseMs: 1000 });
new ShadowOperations(store, effects, {
  execute: async (operation, context) => {
    const result = await adapter.execute(operation, context);
    if (result.status !== "confirmed") throw new Error("fixture mutation failed");
    process.exit(73);
  },
  inspect: (operation, context) => adapter.inspect(operation, context),
}, { now: () => 1000 });
effects.start(); await effects.idle(); process.exit(74);
