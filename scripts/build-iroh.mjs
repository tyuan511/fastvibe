#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const manifest = join(root, "rust", "Cargo.toml");
const executable = process.platform === "win32" ? "fastvibe-iroh.exe" : "fastvibe-iroh";
const built = join(root, "rust", "target", "release", executable);
const resourceDir = join(root, "resources", "iroh");
const staged = join(resourceDir, executable);

execFileSync("cargo", ["build", "--manifest-path", manifest, "--release", "--bin", "fastvibe-iroh"], { stdio: "inherit" });
if (!existsSync(built)) throw new Error(`iroh transport build did not produce ${built}`);
mkdirSync(resourceDir, { recursive: true });
copyFileSync(built, staged);
if (process.platform !== "win32") chmodSync(staged, 0o755);
console.log(`[iroh] staged ${staged}`);
