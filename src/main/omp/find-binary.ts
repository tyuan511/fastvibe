import { existsSync } from "node:fs";
import { join } from "node:path";

export function ompTargetId(): string {
  const arch = process.arch;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "win32") return `windows-${arch}`;
  return `${process.platform}-${arch}`;
}

export function bundledOmpPath(): string | null {
  const target = ompTargetId();
  const name = process.platform === "win32" ? "omp.exe" : "omp";
  const candidates = [
    join(process.resourcesPath, "omp", target, name),
    join(__dirname, "../../resources/omp", target, name),
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

export async function findOmpBinary(): Promise<string | null> {
  const override = process.env.FASTVIBE_OMP;
  if (override && existsSync(override)) return override;
  return bundledOmpPath();
}
