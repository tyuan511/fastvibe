// Explicit continuation of the round-2 App bot acceptance. The main runner stopped at
// review delivery (a host grant-profile conflict, now fixed); external operations were
// already confirmed, so this script inspects the durable state and performs ONLY the
// remaining steps: App bot review delivery, controlled merge, strict issue settlement,
// Source observation and evidence. It invents no new work and refuses any non-confirmed
// persisted operation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { GithubAppInstallationCredentials, resolveAppPrincipal } from "../src/main/bot/shadow/github-app-auth.ts";
import type { GithubOperationKind } from "../src/main/bot/shadow/github-operation.ts";
import { loadGithubAppCredential } from "../src/main/bot/shadow/github-app-setup.ts";
import { GithubPiDeployment } from "../src/main/bot/shadow/github-pi-deployment.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { githubEventToTrigger, registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { assertShadowPath } from "../src/main/bot/shadow/schema.ts";
import { openShadowStore, type Operation } from "../src/main/bot/shadow/store.ts";

const execFileAsync = promisify(execFile);
const command = async (file: string, args: string[], options?: Record<string, unknown>): Promise<string> => String((await execFileAsync(file, args, options as never)).stdout);
const api = async (path: string): Promise<any> => JSON.parse(await command("/opt/homebrew/bin/gh", ["api", path]));
const repoName = "tyuan511/vivi-test", repoId = "1450887533", source = "github", instance = "vivi-test-m11";
const issueNumber = 3, pullNumber = 4;
const ALLOWED: readonly GithubOperationKind[] = ["commit", "push", "pull", "review", "merge", "issue-close"];
const repository = { id: repoId, owner: "tyuan511", name: "vivi-test" };

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--") ? process.argv[index + 1] : undefined;
};

async function main(): Promise<void> {
  const root = realpathSync(resolve(arg("root")!));
  assert.ok(arg("root"), "Pass --root with the round-2 acceptance directory");
  assertShadowPath(root);
  assert.ok(!existsSync(join(root, "evidence.json")), "This acceptance attempt already completed");
  const githubAppFile = arg("github-app") ?? resolve(homedir(), ".fastvibe", "vivi-github-app.json");
  const store = openShadowStore(join(root, "state.db"));
  let deployment: GithubPiDeployment | undefined;
  try {
    const ticketId = store.get<string>("live:ticket");
    assert.ok(ticketId, "The durable store must carry the accepted ticket");
    for (const row of store.db.all<{ data: string }>("SELECT data FROM dsh_operations")) {
      const operation = JSON.parse(row.data) as Operation;
      assert.equal(operation.status, "confirmed", `Persisted operation ${operation.key} is ${operation.status}; explicit reconciliation required`);
    }
    const [user, remoteRepo, pr] = await Promise.all([api("user"), api(`repos/${repoName}`), api(`repos/${repoName}/pulls/${pullNumber}`)]);
    assert.equal(user.login, "tyuan511");
    assert.equal(pr.state, "open"); assert.equal(pr.merged, false);
    const appRecord = loadGithubAppCredential(githubAppFile);
    assert.ok(appRecord && appRecord.installationId !== undefined, `GitHub App 凭据缺少 installationId：${githubAppFile}`);
    const principal = await resolveAppPrincipal({ appId: appRecord.appId, privateKeyPem: appRecord.pem, expectedSlug: appRecord.slug });
    const reviewerIdentity = { id: principal.botUserId, login: principal.botLogin };
    console.log(JSON.stringify({ stage: "configured", reviewer: reviewerIdentity.login, reviewerId: reviewerIdentity.id }));

    const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    const credentialHost = new ShadowCredentialHost(registry);
    credentialHost.register({ id: "vivi-test.gh.writer", kind: "github" }, { resolve: async () =>
      (await command("/opt/homebrew/bin/gh", ["auth", "token", "--hostname", "github.com"])).trim() });
    credentialHost.register({ id: "vivi-test.gh.app-reviewer", kind: "github" }, new GithubAppInstallationCredentials({
      appId: appRecord.appId, privateKeyPem: appRecord.pem, installationId: appRecord.installationId!, expectedSlug: appRecord.slug, repositories: ["vivi-test"] }));
    credentialHost.bind(source, { id: "vivi-test.gh.writer", kind: "github" });
    credentialHost.bind("github-review", { id: "vivi-test.gh.app-reviewer", kind: "github" });
    const writer = new GithubRestTransport({ repository, credentials: credentialHost, source });
    const reviewerTransport = new GithubRestTransport({ repository, credentials: credentialHost, source: "github-review", principalMode: "github-app" });
    const policy: Policy = { version: "vivi-test-explicit-owner-v1", paused: false, evalTimeoutMs: 120_000,
      gate: trigger => trigger.source === source && String(trigger.meta.repositoryId) === repoId && trigger.meta.number === issueNumber
        ? { admissible: true, strength: "explicit", basis: { via: "listed" } } : { admissible: false, reason: "ignored" as never },
      revalidate: () => true, admitsInferred: () => false };

    const modelId = process.env.PI_MODEL ?? "codex/gpt-6.1-sol", provider = process.env.PI_PROVIDER ?? "magpie";
    const modelRuntime = await ModelRuntime.create({ modelsPath: join(homedir(), ".pi/agent/models.json"), authPath: join(homedir(), ".pi/agent/auth.json"),
      modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
    const model = modelRuntime.getModel(provider, modelId);
    assert.ok(model && await modelRuntime.getAuth(model), `The model must resolve: ${provider}/${modelId}`);

    const prTarget = { pullNumber, headSha: pr.head.sha, baseSha: pr.base.sha };
    deployment = new GithubPiDeployment(store, registry, {
      native: { reader: writer, writer, reviewer: reviewerTransport,
        writerIdentity: { id: String(user.id), login: user.login }, reviewerIdentity, requiredChecks: ["test"], source, instance,
        driver: { policy: () => policy, intervalMs: false },
        adapters: { assessment: async () => { throw new Error("Only the explicit host decision is configured"); }, release: async () => {}, relay: async () => {}, notice: async () => {} } },
      worker: { root: join(root, "workers"), modelRuntime, model, maxWorkers: () => 1 },
      reviewDelivery: { source, instance, repositoryId: repoId, target: () => ({ ...prTarget }), allowed: ALLOWED, settleIssue: true },
      poll: false,
    });
    deployment.start();
    const engine = deployment.native.driver.engine;
    const binding = engine.currentBinding(ticketId);
    assert.ok(binding, "The ticket must keep a live binding");
    const record = store.db.all<{ data: string }>("SELECT data FROM dsh_source_cursors WHERE source='pi-reviewer'")
      .map(row => JSON.parse(row.data) as { artifactId: string; status: string; headSha: string })
      .find(row => row.status === "completed" && row.headSha === pr.head.sha);
    assert.ok(record, "A completed reviewer artifact for the PR head must exist");
    const requireConfirmed = async (operation: Pick<Operation, "source" | "instance" | "key">) => {
      await deployment!.native.idle();
      const row = store.operations.get(operation.source, operation.instance, operation.key);
      assert.equal(row?.status, "confirmed", `Operation ${operation.key} is not confirmed`);
      return row!;
    };

    // 1) The durable artifact becomes the App bot's GitHub review.
    const review = await requireConfirmed(deployment.planReview(binding, record.artifactId));
    console.log(JSON.stringify({ stage: "github-review-confirmed", operation: review.key, receipt: review.receipt }));

    // 2) The required CI check must be green on the exact head.
    const runs = await api(`repos/${repoName}/commits/${pr.head.sha}/check-runs?per_page=100`) as { check_runs?: { name?: unknown; id?: unknown; status?: unknown; conclusion?: unknown }[] };
    const latest = new Map<string, { id: number; status?: unknown; conclusion?: unknown }>();
    for (const run of runs.check_runs ?? []) { const name = String(run.name); const current = latest.get(name); if (current === undefined || Number(run.id) > current.id) latest.set(name, { id: Number(run.id), status: run.status, conclusion: run.conclusion }); }
    const test = latest.get("test");
    assert.ok(test?.status === "completed" && test.conclusion === "success", `CI not green: ${JSON.stringify([...latest.entries()])}`);
    console.log(JSON.stringify({ stage: "ci-success", head: pr.head.sha }));

    // 3) Pre-merge Issue observation for the settlement continuation.
    const issueBefore = await api(`repos/${repoName}/issues/${issueNumber}`) as { updated_at?: unknown };
    const eventsBefore = await api(`repos/${repoName}/issues/${issueNumber}/events?per_page=100`) as unknown[];
    const frontier = eventsBefore.reduce<number>((max, event) => Math.max(max, Number((event as { id?: unknown }).id) || 0), 0);
    assert.ok(typeof issueBefore.updated_at === "string", "Issue observation lacks updated_at");

    // 4) Controlled merge through the same App bot credential.
    const authorization = deployment.native.grant(binding, ALLOWED, { settleIssue: true });
    const merge = await requireConfirmed(deployment.native.planAndQueue({ kind: "merge", source, instance, repositoryId: repoId, authorization,
      object: { pullNumber }, params: { method: "squash" }, preconditions: { headSha: pr.head.sha, baseSha: pr.base.sha, currentState: "open" } }));
    const mergeReceipt = merge.receipt as Record<string, unknown>;
    const mergeSha = String(mergeReceipt.sha ?? mergeReceipt.merge_commit_sha ?? "");
    assert.ok(/^[0-9a-f]{40}$/i.test(mergeSha), `Merge receipt lacks a SHA: ${JSON.stringify(mergeReceipt)}`);
    console.log(JSON.stringify({ stage: "merge-confirmed", mergeSha }));

    // 5) Strict settlement: GitHub already auto-closed the linked Issue; the close
    //    operation confirms from the external linked-merge close event, no PATCH.
    const pullThread = githubEventToTrigger({ type: "pull_request", pull_request: pr, repository: remoteRepo }, source, instance,
      { repository, selfLogins: [user.login], botLogins: [reviewerIdentity.login] }).threads[0]!;
    const continuation = deployment.native.settlement.closeMergedThread(engine.sources, pullThread, {
      ticketId, originIssue: issueNumber, pullThread, closedAt: new Date().toISOString(),
      mergeOperation: { source: merge.source, instance: merge.instance, key: merge.key },
      closeRequest: { kind: "issue-close" as const, source, instance, repositoryId: repoId,
        object: { issueNumber }, authorization,
        params: { mergeCommit: mergeSha, pullNumber },
        preconditions: { currentState: "open" as const, issueUpdatedAt: issueBefore.updated_at as string, issueEventFrontier: frontier } },
    });
    await deployment.native.idle();
    const view = deployment.native.settlement.get(ticketId);
    assert.equal(view?.status, "confirmed", `Issue settlement is not confirmed: ${JSON.stringify(view)}`);
    console.log(JSON.stringify({ stage: "issue-settlement-confirmed", mergeSha }));

    // 6) The Source observes the merged PR and the closed Issue.
    await deployment.native.poll({ targets: [], threads: [pullNumber], bindings: [{ ticketId, branch: "dsh/issue-3", repositoryId: repoId }] });

    const operations = store.db.all<{ data: string }>("SELECT data FROM dsh_operations").map(row => JSON.parse(row.data) as Operation);
    const evidence = { repository: repoName, repositoryId: repoId, ticketId,
      issue: `https://github.com/${repoName}/issues/${issueNumber}`, pull: pr.html_url,
      operations: operations.map(operation => ({ kind: (operation.payload as { kind?: string }).kind, status: operation.status, receipt: operation.receipt })),
      settlement: continuation, reviewer: reviewerIdentity, status: "app-bot-closed-loop-confirmed",
      at: new Date().toISOString() };
    writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: "complete", evidence: join(root, "evidence.json") }));
  } finally {
    await deployment?.stop({ abort: true });
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
