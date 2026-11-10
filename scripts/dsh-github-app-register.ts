// Manually invoked GitHub App registration helper for the Vivi M11 acceptance round.
// Runs the manifest one-click flow against real GitHub: serves a local start page,
// waits for the redirect callback, exchanges the one-hour code, and writes a 0600
// credential file. The script never touches repositories; installing the App on a
// repository is done on GitHub and recorded afterwards with --installation.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listInstallations, resolveAppPrincipal } from "../src/main/bot/shadow/github-app-auth.ts";
import { beginGithubAppSetup, loadGithubAppCredential, organizationRegistrationAction, saveGithubAppCredential } from "../src/main/bot/shadow/github-app-setup.ts";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--") ? process.argv[index + 1] : undefined;
};

async function recordInstallation(out: string, installation: string): Promise<void> {
  if (!existsSync(out)) throw new Error(`凭据文件不存在，请先完成注册：${out}`);
  const record = loadGithubAppCredential(out);
  if (!record) throw new Error("凭据文件无效");
  const installations = await listInstallations({ appId: record.appId, privateKeyPem: record.pem });
  const chosen = Number(installation);
  if (!installations.some(item => item.installationId === chosen)) {
    throw new Error(`安装 #${installation} 不存在。当前安装：${installations.map(item => `#${item.installationId}(${item.accountLogin})`).join("、") || "无"}`);
  }
  saveGithubAppCredential(out, { ...record, installationId: chosen });
  console.log(`已记录安装 #${chosen}（${installations.find(item => item.installationId === chosen)!.accountLogin}）→ ${out}`);
}

async function register(out: string): Promise<void> {
  const org = arg("org");
  const handle = await beginGithubAppSetup({
    manifest: { name: "Vivi", homepage: "https://github.com/tyuan511/fastvibe", permissions: { pull_requests: "write", contents: "write", checks: "read", statuses: "read" } },
    startPage: true,
    ...(org ? { registrationAction: organizationRegistrationAction(org) } : {}),
    timeoutMs: Number(arg("timeout-ms") ?? 15 * 60_000),
  });
  console.log(`1/4 在浏览器打开此页面并确认注册（GitHub 会要求登录）：\n    ${handle.startUrl}`);
  console.log(`2/4 注册完成后 GitHub 会跳回 ${handle.callbackUrl}，该页面可以关闭。`);
  if (!process.argv.includes("--no-open") && handle.startUrl) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
    if (opener) execFile(opener, [handle.startUrl], () => {});
  }
  const conversion = await handle.completed;
  saveGithubAppCredential(out, { ...conversion, createdAt: new Date().toISOString() });
  console.log(`3/4 凭据已保存（appId=${conversion.appId} slug=${conversion.slug}）→ ${out}`);
  const identity = await resolveAppPrincipal({ appId: conversion.appId, privateKeyPem: conversion.pem, expectedSlug: conversion.slug });
  console.log(`    bot 身份：${identity.botLogin}（id=${identity.botUserId}）`);
  const installations = await listInstallations({ appId: conversion.appId, privateKeyPem: conversion.pem });
  if (installations.length === 1) {
    saveGithubAppCredential(out, { ...conversion, installationId: installations[0]!.installationId, createdAt: new Date().toISOString() });
    console.log(`4/4 已自动记录唯一安装 #${installations[0]!.installationId}（${installations[0]!.accountLogin}）。`);
    return;
  }
  console.log(`4/4 请先安装到目标仓库：https://github.com/apps/${conversion.slug}/installations/new`);
  console.log(installations.length === 0
    ? "    尚无安装。安装后重新运行本脚本并传 --installation <id>。"
    : `    存在多个安装，请用 --installation <id> 选择：${installations.map(item => `#${item.installationId}(${item.accountLogin})`).join("、")}`);
}

async function main(): Promise<void> {
  const out = arg("out") ?? resolve(homedir(), ".fastvibe", "vivi-github-app.json");
  const installation = arg("installation");
  if (installation) {
    if (!existsSync(out)) throw new Error(`凭据文件不存在：${out}`);
    await recordInstallation(out, installation);
    return;
  }
  if (existsSync(out) && !process.argv.includes("--force")) throw new Error(`凭据文件已存在（${out}）。重新注册会创建新的 App；确认请加 --force。`);
  await register(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
