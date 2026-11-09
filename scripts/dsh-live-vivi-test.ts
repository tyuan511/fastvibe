// Explicit, manually invoked M11 laboratory for the user-authorized tyuan511/vivi-test repository.
// No production registration. Credentials remain in host memory; model tools see the scratch checkout only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { executionPaths } from "../src/main/bot/shadow/execution-directory.ts";
import { GithubPiDeployment } from "../src/main/bot/shadow/github-pi-deployment.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { GithubShadowSource, githubEventToTrigger, registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ManagedGitRepository } from "../src/main/bot/shadow/git-repository.ts";
import { ManagedPiReviewer } from "../src/main/bot/shadow/pi-reviewer.ts";
import { PiLedger } from "../src/main/bot/shadow/pi-ledger.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { assertShadowPath } from "../src/main/bot/shadow/schema.ts";
import { openShadowStore, type Operation } from "../src/main/bot/shadow/store.ts";
import { WorkspaceFiles } from "../src/main/bot/shadow/pi-workspace.ts";

const exec = promisify(execFile);
const repoName = "tyuan511/vivi-test", repoId = "1450887533", remote = `https://github.com/${repoName}.git`;
const source = "github", instance = "vivi-test-m11";
const repository = { id: repoId, owner: "tyuan511", name: "vivi-test", fullName: repoName };
const safeEnv = { PATH: "/usr/bin:/bin:/opt/homebrew/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function command(file: string, args: string[], options: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  try { return (await exec(file, args, { ...options, timeout: options.timeout ?? 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch { throw new Error("Host command failed; inspect the recorded stage and dedicated repository"); }
}
async function api(path: string): Promise<any> { return JSON.parse(await command("/opt/homebrew/bin/gh", ["api", path])); }
const runtime = () => ModelRuntime.create({ modelsPath: join(homedir(), ".pi/agent/models.json"), authPath: join(homedir(), ".pi/agent/auth.json"),
  modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });

export async function runViviTest(rootInput: string, reconcileDeadWorker = false, feedbackFile?: string): Promise<void> {
  const root = realpathSync(resolve(rootInput)); assertShadowPath(root);
  assert.ok(!existsSync(join(root, "evidence.json")), "This acceptance attempt is complete; inspect its evidence instead of rerunning it");
  const seed = join(root, "seed"), workerRoot = join(root, "workers"), file = join(root, "state.db");
  assert.ok(existsSync(join(seed, ".git")), "A dedicated seed checkout is required");
  mkdirSync(workerRoot, { recursive: true, mode: 0o700 });
  let stage = "preflight";
  const log = (next: string, data: unknown = {}) => { stage = next; console.log(JSON.stringify({ stage, at: new Date().toISOString(), data })); };
  const store = openShadowStore(file);
  // This laboratory resumes SDK work only before Git/REST delivery. External unknowns
  // must be inspected through their persisted operation API, never rebuilt with a new timestamp.
  const hasExternalIntents = store.db.countRows("dsh_operations") > 0;
  if (hasExternalIntents) store.close();
  assert.ok(!hasExternalIntents, "Existing external intents require explicit operation inspection; do not rerun this laboratory");
  let deployment: GithubPiDeployment | undefined, reviewer: ManagedPiReviewer | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const [remoteRepo, user, issue, reservedBot, workerRuntime, reviewerRuntime] = await Promise.all([
      api(`repos/${repoName}`), api("user"), api(`repos/${repoName}/issues/1`), api("users/github-actions%5Bbot%5D"), runtime(), runtime(),
    ]);
    assert.equal(String(remoteRepo.id), repoId); assert.equal(remoteRepo.full_name, repoName);
    assert.equal(user.login, "tyuan511"); assert.equal(issue.number, 1); assert.equal(issue.state, "open");
    const baseline = (await command("/usr/bin/git", ["-C", seed, "rev-parse", "HEAD"])).trim();
    assert.equal((await api(`repos/${repoName}/git/ref/heads/main`)).object.sha, baseline);
    const modelId = process.env.PI_MODEL ?? "codex/gpt-6.1-sol", provider = process.env.PI_PROVIDER ?? "magpie";
    const model = workerRuntime.getModel(provider, modelId), reviewModel = reviewerRuntime.getModel(provider, modelId);
    assert.ok(model && reviewModel, "The explicitly allowed model configuration must resolve");
    assert.ok(await workerRuntime.getAuth(model)); assert.ok(await reviewerRuntime.getAuth(reviewModel));
    log("configured", { repositoryId: repoId, writer: user.login, provider, model: modelId, independentGithubReviewer: "not-configured" });
    const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    if (!registry.instance(source)?.revision) registry.configure(source, { enabled: true,
      config: { repository, selfLogins: [user.login], botLogins: [reservedBot.login] } });
    const credentialHost = new ShadowCredentialHost(registry);
    credentialHost.register({ id: "vivi-test.gh.writer", kind: "github" }, { resolve: async () =>
      (await command("/opt/homebrew/bin/gh", ["auth", "token", "--hostname", "github.com"])).trim() });
    // This real bot identity is reserved for a future explicit credential. No identity is impersonated.
    credentialHost.register({ id: "vivi-test.unconfigured-reviewer", kind: "github" }, { resolve: async () => { throw new Error("Independent reviewer credential is not configured"); } });
    if (!registry.credentialBinding(source)) credentialHost.bind(source, { id: "vivi-test.gh.writer", kind: "github" });
    if (!registry.credentialBinding("github-review")) credentialHost.bind("github-review", { id: "vivi-test.unconfigured-reviewer", kind: "github" });
    const writer = new GithubRestTransport({ repository, credentials: credentialHost, source });
    const reviewerTransport = new GithubRestTransport({ repository, credentials: credentialHost, source: "github-review" });
    const policy: Policy = { version: "vivi-test-explicit-owner-v1", paused: false, evalTimeoutMs: 120_000,
      gate: trigger => trigger.source === source && String(trigger.meta.repositoryId) === repoId && trigger.meta.number === 1
        ? { admissible: true, strength: "explicit", basis: { via: "listed" } } : { admissible: false, reason: "ignored" as never },
      revalidate: () => true, admitsInferred: () => false };
    const host = new ShadowEngine(store, { scope: registry, policy: () => policy });
    let ticketId = store.get<string>("live:ticket");
    if (!ticketId) {
      const result = await new GithubShadowSource({ store, registry, engine: host, reader: writer, source, instance,
        since: new Date(Date.parse(issue.created_at) - 1000).toISOString(), targets: [{ id: "issue-1", path: `/repos/${repoName}/issues/1`, kind: "issue" }] }).poll();
      assert.equal(result.status, "completed", `Source poll failed: ${result.error ?? result.status}`);
      // Source deliberately ignores its writer's own events. This one-account laboratory
      // requires the explicitly authorized operator to replay their own issue; preserve
      // self=true/human=false rather than fabricating an independent human event.
      if (!store.db.countRows("dsh_triggers")) {
        const trigger = githubEventToTrigger({ type: "issues", issue, repository: remoteRepo }, source, instance,
          { repository, selfLogins: [user.login], botLogins: [reservedBot.login] });
        assert.equal(trigger.meta.self, true); assert.equal(trigger.human, false);
        host.sources.receive(trigger);
        log("explicit-self-issue-replay", { issue: issue.html_url, self: true, human: false, reason: "operator-authorized manual replay; automatic Source suppresses self events" });
      }
      host.evaluateDue();
      const triggers = store.db.all<{ id: string }>("SELECT id FROM dsh_triggers").map(row => store.triggers.get(row.id)!).filter(t => t.meta.kind === "issue" && t.meta.number === 1);
      assert.equal(triggers.length, 1); const trigger = triggers[0]!, candidate = host.main.candidate(trigger.id); assert.ok(candidate);
      ticketId = host.main.decide(trigger.id, { evalId: candidate.evalId, kind: "accept", title: issue.title, scope: repoName,
        reason: "The operator explicitly authorized this dedicated acceptance repository", audit: { operator: user.login, assessment: "manual-host-decision" } }).ticketId;
      assert.ok(ticketId); store.set("live:ticket", ticketId);
      host.sources.bindThread(ticketId, trigger.threads[0]!, false);
      log("issue-accepted", { issue: issue.html_url, triggerId: trigger.id, ticketId, human: trigger.human, assessment: "manual-host-decision" });
    }
    const id = ticketId;
    const savedLedger = new PiLedger(store), savedSession = savedLedger.session(`worker-${id}`);
    if (feedbackFile) {
      assert.equal(realpathSync(resolve(feedbackFile)), join(root, "host-feedback.txt"));
      assert.ok(savedSession?.paused && !store.get(`pi:owner:worker-${id}`), "Host feedback requires a quiet previous SDK owner");
      const previous = host.currentBinding(id); assert.ok(previous);
      assert.ok(savedLedger.list(`worker-${id}`).filter(receipt => receipt.binding.assignmentId === previous.assignmentId)
        .every(receipt => ["settled", "handled", "rejected", "stopped"].includes(receipt.status)));
      host.worker.report(previous, { state: "failed", summary: "Host immutable acceptance: 8 passed, 2 failed. See the separately persisted host test feedback; the model's prior reports remain unchanged." });
      host.people.retryTicket(id);
      // Add automated host facts after the new Assignment is queued: a failed/ready
      // Assignment deliberately holds automatic notes while waiting for a person.
      host.main.note(id, readFileSync(feedbackFile, "utf8"));
      log("host-test-repair-queued", { ticketId: id, previousAssignment: previous.assignmentId, feedback: "host-feedback.txt" });
    } else if (savedSession?.paused) {
      assert.ok(!store.get(`pi:owner:worker-${id}`), "Previous SDK owner must be gone");
      const previous = host.currentBinding(id); assert.ok(previous);
      const receipts = savedLedger.list(`worker-${id}`).filter(receipt => receipt.binding.assignmentId === previous.assignmentId);
      if (!receipts.length) {
        assert.equal(host.worker.interrupted(previous), true);
        log("explicit-pre-dispatch-recovery", { ticketId: id, previousAssignment: previous.assignmentId, providerInputs: 0 });
      } else {
        assert.ok(reconcileDeadWorker && receipts.every(receipt => ["settled", "handled", "rejected", "stopped"].includes(receipt.status)), "Provider-visible inputs require explicit receipt reconciliation before another attempt");
        log("resume-settled-host-delivery", { ticketId: id, assignmentId: previous.assignmentId, receipts: receipts.length, replayProvider: false });
      }
    }
    const paths = executionPaths(workerRoot, id), ref = `refs/heads/dsh/issue-1` as const;
    const git = new ManagedGitRepository({ directory: paths.cwd, ref, remote, credentials: async () => ({ username: user.login,
      password: (await command("/opt/homebrew/bin/gh", ["auth", "token", "--hostname", "github.com"])).trim() }) });
    deployment = new GithubPiDeployment(store, registry, {
      native: { reader: writer, writer, reviewer: reviewerTransport, writerIdentity: { id: String(user.id), login: user.login },
        reviewerIdentity: { id: String(reservedBot.id), login: reservedBot.login }, requiredChecks: ["test"], source, instance,
        git: { repository: git, directoryRevision: () => deployment?.executor.directories.get(id)?.revision },
        driver: { policy: () => policy, intervalMs: false },
        adapters: { assessment: async () => { throw new Error("Only the explicit host decision is configured"); }, release: async () => {}, relay: async () => {}, notice: async () => {} } },
      worker: { root: workerRoot, modelRuntime: workerRuntime, model, maxWorkers: () => 1, initialAssignment: true,
        recipe: { id: "vivi-test-seed-v1", run: async context => {
          assert.equal(context.cwd, paths.cwd);
          if (!existsSync(join(context.cwd, ".git"))) {
            const args = ["-C", context.cwd];
            const runGit = (rest: string[]) => command("/usr/bin/git", [...args, ...rest], { env: { ...safeEnv, HOME: context.base, GIT_COMMITTER_NAME: "Vivi acceptance", GIT_COMMITTER_EMAIL: "15307345+tyuan511@users.noreply.github.com" }, signal: context.signal });
            await runGit(["init", "-b", "dsh/issue-1"]);
            await runGit(["-c", "protocol.file.allow=always", "fetch", "--no-tags", seed, baseline]);
            await runGit(["update-ref", ref, baseline]); await runGit(["read-tree", "--reset", "-u", baseline]);
          }
          return { repositoryId: repoId, baselineSha: baseline };
        } } }, poll: false,
    });
    deadline = setTimeout(() => { log("deadline"); void deployment?.stop({ abort: true }); }, 6 * 60_000);
    deadline.unref();
    deployment.start();
    if (reconcileDeadWorker) {
      deployment.executor.reconcile(id, { quiet: true });
      log("explicit-post-dispatch-recovery", { ticketId: id, recovery: "dead worker reconciled; old provider requests are not reactivated" });
    }
    log("worker-started", { ticketId: id });
    await deployment.idle();
    const engine = deployment.native.driver.engine, binding = engine.currentBinding(id); assert.ok(binding, "The issue Follow must keep the Ticket open");
    const ledger = new PiLedger(store), reports = ledger.list(`worker-${id}`)
      .filter(receipt => receipt.binding.assignmentId === binding.assignmentId)
      .flatMap(receipt => receipt.reports.filter(value => value.binding.assignmentId === binding.assignmentId).map(value => value.report));
    assert.ok(reports.some(report => report.state === "ready"), "A structured ready report is required before host delivery");
    const workerState = deployment.executor.record(id); assert.equal(workerState?.state, "opened");
    log("worker-ready", { ticketId: id, reports: reports.map(r => ({ state: r.state, summary: r.summary })) });
    const runTests = async (name: string, fileName: string) => {
      try {
        const output = await command(process.execPath, ["--test", "--test-reporter=tap", fileName], { cwd: paths.cwd, env: { PATH: "/usr/bin:/bin", HOME: paths.base }, timeout: 30_000 });
        writeFileSync(join(root, "logs", `${name}.log`), output, { mode: 0o600 }); return { name, status: "passed" as const, evidence: `host Node test: ${name}; log ${name}.log` };
      } catch { throw new Error(`Host test did not pass: ${name}`); }
    };
    const fixedTest = readFileSync(join(seed, "test/quiet-hours.test.js"), "utf8").replace(/(['"])\.\.\/src\/quiet-hours\.js\1/g, JSON.stringify(pathToFileURL(join(paths.cwd, "src/quiet-hours.js")).href));
    const acceptanceFile = join(root, "acceptance.test.mjs"); writeFileSync(acceptanceFile, fixedTest, { mode: 0o600 });
    const checks = [await runTests("immutable-acceptance", acceptanceFile), await runTests("workspace-tests", join(paths.cwd, "test/quiet-hours.test.js"))];
    log("host-tests-passed", checks);
    const changed = new Set([
      ...(await command("/usr/bin/git", ["-C", paths.cwd, "diff", "--name-only", "-z", baseline])).split("\0"),
      ...(await command("/usr/bin/git", ["-C", paths.cwd, "ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
    ].filter(Boolean));
    assert.ok(changed.size); for (const path of changed) assert.ok(["src/quiet-hours.js", "test/quiet-hours.test.js"].includes(path), "Worker changed a path outside the acceptance scope");
    const files = new WorkspaceFiles(paths.cwd, () => assert.deepEqual(engine.currentBinding(id), binding));
    const changes = [...changed].sort().map(path => ({ path, content: files.read(path), mode: "100644" as const }));
    const authorization = deployment.native.grant(binding, ["commit", "push", "pull", "review", "merge", "issue-close"], { settleIssue: true });
    const directoryRevision = deployment.executor.directories.get(id)!.revision;
    const snapshot = await deployment.native.git!.prepareCommit({ parentSha: baseline, changes, message: "fix: handle wrapping and overlapping quiet hours", author: { name: "Vivi acceptance", email: "15307345+tyuan511@users.noreply.github.com" }, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z") }, authorization, directoryRevision);
    const requireConfirmed = async (operation: Operation) => { await deployment!.native.idle(); const row = store.operations.get(operation.source, operation.instance, operation.key); assert.equal(row?.status, "confirmed", `Operation ${operation.key} is not confirmed`); return row!; };
    const commit = await requireConfirmed(deployment.native.planGitAndQueue({ kind: "commit", authorization, snapshot, directoryRevision }));
    log("commit-confirmed", commit.receipt);
    const remoteHead = await git.remoteRef(); assert.ok(remoteHead === null || remoteHead === snapshot.sha, "An unrelated remote branch requires reconciliation");
    const push = await requireConfirmed(deployment.native.planGitAndQueue({ kind: "push", authorization, snapshot, directoryRevision, expectedRemoteSha: null }));
    log("push-confirmed", push.receipt);
    const pull = await requireConfirmed(deployment.native.planAndQueue({ kind: "pull", source, instance, repositoryId: repoId, authorization,
      object: {}, params: { headBranch: "dsh/issue-1", baseBranch: "main", title: "Fix wrapping and overlapping quiet hours", body: "Related to #1.\n\nActual SDK Worker changes, host-verified tests and managed Git delivery. Independent model artifact will be recorded separately; native independent GitHub review remains pending." },
      preconditions: { headSha: snapshot.sha, baseSha: baseline } }));
    const pullNumber = (pull.receipt as { number: number }).number;
    log("pull-confirmed", { url: `https://github.com/${repoName}/pull/${pullNumber}`, head: snapshot.sha });
    const pr = await api(`repos/${repoName}/pulls/${pullNumber}`);
    await deployment.native.poll({ targets: [], threads: [pullNumber], bindings: [{ ticketId: id, branch: "dsh/issue-1", repositoryId: repoId }] });
    const reviewFiles = ["src/quiet-hours.js", "test/quiet-hours.test.js"].map(path => ({ path, content: readFileSync(join(paths.cwd, path), "utf8") }));
    const contents = new Map(reviewFiles.map(file => [file.path, file.content]));
    reviewer = await ManagedPiReviewer.open({ store, root: workerRoot, modelRuntime: reviewerRuntime, model: reviewModel, binding,
      isCurrent: () => JSON.stringify(engine.currentBinding(id)) === JSON.stringify(binding), snapshot: () => ({ headSha: pr.head.sha, baseSha: pr.base.sha }),
      readFile: async file => { const content = contents.get(file.path); assert.ok(content !== undefined); return { content, version: digest(content) }; } });
    const artifact = await reviewer.review({ artifactId: `vivi-test-pr-${pullNumber}-${snapshot.sha}`, headSha: pr.head.sha, baseSha: pr.base.sha,
      diff: await command("/usr/bin/git", ["-C", paths.cwd, "diff", baseline, snapshot.sha]), requirements: issue.body,
      files: reviewFiles.map(file => ({ path: file.path, version: digest(file.content) })), verifiedChecks: checks });
    assert.equal(artifact.status, "completed");
    log("model-review-completed", { verdict: artifact.artifact?.verdict, findings: artifact.artifact?.findings.length, artifactId: artifact.artifactId });
    const evidence = { repository: repoName, repositoryId: repoId, issue: issue.html_url, pull: pr.html_url, ticketId: id, binding,
      baselineSha: baseline, headSha: snapshot.sha, checks, commit: commit.receipt, push: push.receipt, pullReceipt: pull.receipt, review: artifact,
      workerReports: reports, status: "independent-github-review-required", limitation: "manual self-issue replay and host Decision; no independent GitHub reviewer credential; CI/Merge/Issue settlement not yet accepted", at: new Date().toISOString() };
    writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    store.set("live:evidence", evidence); log("awaiting-native-review", { evidence: join(root, "evidence.json"), pull: pr.html_url });
  } catch (error) {
    const message = error instanceof assert.AssertionError ? error.message.replace(/(?:gh[opusr]_|sk-)[A-Za-z0-9_-]+/g, "[redacted]") : error instanceof Error && error.message.startsWith("Host ") ? error.message : "Stage failed; inspect durable state before any retry";
    log("failed", { lastStage: stage, root, reason: message }); process.exitCode = 1;
  }
  finally { if (deadline) clearTimeout(deadline); await reviewer?.dispose(); await deployment?.stop({ abort: true }); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--root"); assert.ok(index >= 0 && process.argv[index + 1], "Pass --root with the explicit disposable acceptance directory");
  const feedbackIndex = process.argv.indexOf("--feedback-file");
  await runViviTest(process.argv[index + 1]!, process.argv.includes("--reconcile-dead-worker"), feedbackIndex < 0 ? undefined : process.argv[feedbackIndex + 1]);
}
