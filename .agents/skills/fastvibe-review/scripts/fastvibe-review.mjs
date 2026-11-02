#!/usr/bin/env node
/** Local GitHub App transport. Credentials never leave this process's HTTP headers. */
import { readFileSync, statSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = `Usage:
  fastvibe-review status
  fastvibe-review pr <number|PR-URL>
  fastvibe-review diff <number|PR-URL>
  fastvibe-review api <repository-relative-GET-path>
  fastvibe-review review <number|PR-URL> --input <review.json> [--dry-run]
  fastvibe-review merge <number|PR-URL> --sha <reviewed-HEAD> [--method squash|merge|rebase] [--dry-run]

review.json must contain commit_id and event (COMMENT, REQUEST_CHANGES or APPROVE).
All calls are restricted to the configured repository. Tokens are short-lived and
revoked after each invocation. No personal gh login or global environment is changed.`;
const configPath = join(homedir(), '.config/fastvibe/github-review/config.json');
const argv = process.argv.slice(2);
const command = argv.shift();
let config;
const secrets = [];
let installationToken;
function output(value) { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function fail(message) { throw new Error(message); }
function option(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Missing value for ${name}`);
  const value = argv[i + 1]; argv.splice(i, 2); return value;
}
function flag(name) { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; }
function noExtra() { if (argv.length) fail(`Unexpected argument: ${argv[0]}`); }
function pullNumber(value) {
  if (!value) fail('Missing pull request number or URL');
  const escaped = `${config.owner}/${config.repository}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = value.match(new RegExp(`^https://github\\.com/${escaped}/pull/([1-9][0-9]*)/?(?:[?#].*)?$`));
  const number = match ? match[1] : value;
  if (!/^[1-9][0-9]*$/.test(number)) fail('PR must belong to the configured repository');
  return number;
}
function jwt() {
  const keyStat = statSync(config.privateKeyPath);
  if (process.platform !== 'win32' && (keyStat.mode & 0o077)) fail('Private key permissions must be 0600');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({alg: 'RS256', typ: 'JWT'})}.${encode({iat: now - 60, exp: now + 540, iss: String(config.appId)})}`;
  const token = `${payload}.${createSign('RSA-SHA256').update(payload).sign(readFileSync(config.privateKeyPath)).toString('base64url')}`;
  secrets.push(token); return token;
}
async function api(path, token, {method = 'GET', body, raw = false} = {}) {
  const url = new URL(`https://api.github.com${path}`);
  if (url.origin !== 'https://api.github.com' || !path.startsWith('/') || path.startsWith('//')) fail('Invalid API path');
  const response = await fetch(url, {
    method,
    headers: {Authorization: `Bearer ${token}`, Accept: raw ? 'application/vnd.github.diff' : 'application/vnd.github+json',
      'User-Agent': 'FastVibe-Review-Local', ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let value; try { value = text ? JSON.parse(text) : null; } catch { value = null; }
  if (!response.ok) fail(`GitHub HTTP ${response.status}: ${value?.message ?? response.statusText}`);
  return raw ? text : value;
}
async function authenticate(permissions) {
  const result = await api(`/app/installations/${config.installationId}/access_tokens`, jwt(), {
    method: 'POST', body: {repositories: [config.repository], permissions},
  });
  installationToken = result.token; secrets.push(result.token); return result;
}
async function allPages(path, token, field) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    const items = field ? data[field] : data;
    if (!Array.isArray(items)) fail('Unexpected GitHub pagination response');
    rows.push(...items); if (items.length < 100) return rows;
  }
  fail('Response exceeds pagination limit; inspect manually');
}
async function main() {
  if (!command || command === '--help' || command === 'help') { output(usage); return; }
  if (!['status','pr','diff','api','review','merge'].includes(command)) fail('Unknown command; use --help');
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!/^[A-Za-z0-9_.-]+$/.test(config.owner) || !/^[A-Za-z0-9_.-]+$/.test(config.repository)) fail('Invalid configured repository');
  const root = `/repos/${config.owner}/${config.repository}`;
  const readPermissions = {contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', actions: 'read'};
  if (command === 'status') {
    noExtra();
    const appToken = jwt();
    const app = await api('/app', appToken);
    const installation = await api(`/app/installations/${config.installationId}`, appToken);
    if (app.id !== config.appId || installation.app_id !== app.id || app.slug !== config.appSlug) fail('App identity mismatch');
    if (installation.account.login !== config.owner || installation.suspended_at) fail('Installation owner mismatch or suspended installation');
    const token = await authenticate(readPermissions);
    const repos = await api('/installation/repositories', token.token);
    output({app: {id: app.id, slug: app.slug, bot: `${app.slug}[bot]`}, installationId: installation.id,
      repositorySelection: installation.repository_selection, installedPermissions: installation.permissions,
      requestTokenPermissions: token.permissions, tokenExpiresAt: token.expires_at,
      accessibleRepositories: repos.repositories.map((r) => r.full_name)});
    return;
  }
  if (command === 'api') {
    const relative = argv.shift(); noExtra();
    if (!relative || relative.startsWith('/') || relative.includes('://') || relative.includes('\\') || relative.includes('#')) fail('Use a repository-relative GET path, e.g. pulls/2');
    const url = new URL(`https://api.github.com${root}/${relative}`);
    if (!url.pathname.startsWith(`${root}/`)) fail('API path escapes configured repository');
    const token = await authenticate(readPermissions);
    output(await api(`${url.pathname}${url.search}`, token.token)); return;
  }
  const number = pullNumber(argv.shift());
  const dryRun = flag('--dry-run');
  if (command === 'pr' || command === 'diff') {
    if (dryRun) fail('--dry-run applies to review and merge'); noExtra();
    const token = await authenticate(readPermissions);
    const pr = await api(`${root}/pulls/${number}`, token.token);
    if (command === 'diff') { output(await api(`${root}/pulls/${number}`, token.token, {raw: true})); return; }
    const files = await allPages(`${root}/pulls/${number}/files`, token.token);
    const reviews = await allPages(`${root}/pulls/${number}/reviews`, token.token);
    const checks = await allPages(`${root}/commits/${pr.head.sha}/check-runs`, token.token, 'check_runs');
    const status = await api(`${root}/commits/${pr.head.sha}/status`, token.token);
    output({repository: `${config.owner}/${config.repository}`, number: pr.number, title: pr.title, body: pr.body,
      state: pr.state, draft: pr.draft, author: pr.user.login, base: {ref: pr.base.ref, sha: pr.base.sha},
      head: {ref: pr.head.ref, sha: pr.head.sha}, mergeable: pr.mergeable, mergeableState: pr.mergeable_state,
      changedFiles: pr.changed_files, returnedFiles: files.length, filesComplete: files.length === pr.changed_files,
      files: files.map(({filename,status,additions,deletions}) => ({filename,status,additions,deletions})),
      reviews: reviews.map(({id,user,state,commit_id,submitted_at}) => ({id,author: user.login,state,commit_id,submitted_at})),
      checks: checks.map(({name,status,conclusion,details_url}) => ({name,status,conclusion,details_url})),
      commitStatus: {state: status.state, totalCount: status.total_count}}); return;
  }
  if (command === 'review') {
    const input = option('--input'); noExtra(); if (!input) fail('--input is required');
    const review = JSON.parse(readFileSync(input, 'utf8'));
    if (!['COMMENT','REQUEST_CHANGES','APPROVE'].includes(review.event)) fail('Review requires an explicit event');
    if (!/^[a-f0-9]{40}$/.test(review.commit_id ?? '')) fail('Review requires a full commit_id');
    const allowed = new Set(['commit_id','event','body','comments']);
    if (Object.keys(review).some((key) => !allowed.has(key))) fail('Unsupported review field');
    const token = await authenticate({...readPermissions, pull_requests: dryRun ? 'read' : 'write'});
    const pr = await api(`${root}/pulls/${number}`, token.token);
    if (pr.state !== 'open' || pr.head.sha !== review.commit_id) fail('PR is closed or HEAD changed; review the current commit');
    if (pr.user.login === `${config.appSlug}[bot]` && review.event !== 'COMMENT') fail('App cannot approve or request changes on its own PR');
    const previous = await allPages(`${root}/pulls/${number}/reviews`, token.token);
    const state = {COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED', APPROVE: 'APPROVED'}[review.event];
    if (previous.some((r) => r.user.login === `${config.appSlug}[bot]` && r.commit_id === review.commit_id && r.state === state && r.body === (review.body ?? ''))) fail('Matching review already exists; inspect it before posting again');
    if (dryRun) { output({dryRun: true, repository: `${config.owner}/${config.repository}`, number, sha: review.commit_id, event: review.event, inlineComments: review.comments?.length ?? 0}); return; }
    const result = await api(`${root}/pulls/${number}/reviews`, token.token, {method: 'POST', body: review});
    output({id: result.id, url: result.html_url, state: result.state, commitId: result.commit_id, author: result.user.login}); return;
  }
  const sha = option('--sha'); const method = option('--method') ?? 'squash'; noExtra();
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) fail('Merge requires --sha with the reviewed HEAD');
  if (!['squash','merge','rebase'].includes(method)) fail('Invalid merge method');
  const token = await authenticate({...readPermissions, contents: dryRun ? 'read' : 'write'});
  const pr = await api(`${root}/pulls/${number}`, token.token);
  if (pr.state !== 'open' || pr.draft || pr.head.sha !== sha || pr.base.ref !== config.baseBranch) fail('PR is closed, draft, changed, or targets a different base branch');
  const reviews = await allPages(`${root}/pulls/${number}/reviews`, token.token);
  const latest = reviews.filter((r) => r.user.login === `${config.appSlug}[bot]` && ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state)).at(-1);
  if (latest?.state !== 'APPROVED' || latest.commit_id !== sha) fail('Current HEAD has not been approved by this App');
  const checks = await allPages(`${root}/commits/${sha}/check-runs?filter=latest`, token.token, 'check_runs');
  if (checks.some((c) => c.status !== 'completed' || !['success','neutral','skipped'].includes(c.conclusion))) fail('Checks are pending or unsuccessful');
  const statuses = await api(`${root}/commits/${sha}/status`, token.token);
  if (statuses.total_count > 0 && statuses.state !== 'success') fail('Commit statuses are pending or unsuccessful');
  if (dryRun) { output({dryRun: true, number, sha, method, checkCount: checks.length, statusCount: statuses.total_count}); return; }
  const fresh = await api(`${root}/pulls/${number}`, token.token);
  if (fresh.head.sha !== sha || fresh.base.sha !== pr.base.sha) fail('PR head or base changed during validation');
  const result = await api(`${root}/pulls/${number}/merge`, token.token, {method: 'PUT', body: {sha, merge_method: method}});
  output({merged: result.merged, sha: result.sha, message: result.message});
  if (!result.merged) process.exitCode = 1;
}
try { await main(); }
catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  console.error(`fastvibe-review: ${message}`); process.exitCode = 1;
} finally {
  if (installationToken) {
    try { await api('/installation/token', installationToken, {method: 'DELETE'}); }
    catch { console.error('Token revocation could not be confirmed; it will expire automatically.'); }
  }
}
