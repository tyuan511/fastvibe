// SPDX-License-Identifier: MIT
import { openShadowStore } from "../../src/main/bot/shadow/store.ts";
import { ShadowSourceRegistry } from "../../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../../src/main/bot/shadow/credential-host.ts";
import { GithubRestTransport } from "../../src/main/bot/shadow/github-transport.ts";
import { GithubNativeOperationAdapter } from "../../src/main/bot/shadow/github-native-operation.ts";
import { ShadowEffects } from "../../src/main/bot/shadow/effects.ts";
import { ShadowOperations } from "../../src/main/bot/shadow/operations.ts";
const [file, baseUrl] = process.argv.slice(2); if (!file || !baseUrl) throw new Error("missing child fixture arguments");
const store = openShadowStore(file), registry = new ShadowSourceRegistry(store), host = new ShadowCredentialHost(registry);
for (const [source, value] of [["github", "fake-writer"], ["github-review", "fake-reviewer"]]) host.register({ id: source!, kind: "github" }, { resolve: async () => value });
const transport = (source: string) => new GithubRestTransport({ repository: { id: 11, owner: "acme", name: "widget" }, credentials: host, source, baseUrl, loopbackTest: true });
const effects = new ShadowEffects(store, { now: () => 1000, owner: "native-crash", leaseMs: 1000 });
const adapter = new GithubNativeOperationAdapter({ store, writer: transport("github"), reviewer: transport("github-review"), writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" },
  requiredChecks: ["test"], authorize: () => {}, now: () => 1000 });
new ShadowOperations(store, effects, { execute: async (op, context) => { const result = await adapter.execute(op, context); if (result.status !== "confirmed") throw new Error("native child write refused"); process.exit(75); },
  inspect: (op, context) => adapter.inspect(op, context) }, { now: () => 1000 });
effects.start(); await effects.idle(); process.exit(76);
