/**
 * What a computer-control install has to fetch, pinned to the npm package version.
 *
 * The bindings stay in the app (they are small). The native library and the private
 * worker do not: together they are most of the feature's size, and only a machine
 * that turns 电脑操控 on ever needs them. Checksums are the release's own, copied
 * here so a swapped archive cannot be executed just because the download succeeded.
 *
 * The worker and the bindings must stay on the same version. cua's own note: upgrade
 * them together.
 */

export const CUA_DRIVER_VERSION = "0.28.2";

/** Same GitHub mirror the Agent runtime uses (`src/main/ssh/remote-shell.ts`). */
export const CUA_GITHUB_MIRROR = "https://gh-proxy.com/";

const TAG = `cua-driver-rs-v${CUA_DRIVER_VERSION}`;
const RELEASE = `https://github.com/trycua/cua/releases/download/${TAG}`;

export type CuaArtifactKind = "worker" | "native";

export type CuaArtifact = {
  kind: CuaArtifactKind;
  filename: string;
  sha256: string;
  url: string;
};

export type CuaPlatformSpec = {
  version: string;
  /** Optional npm package the bindings resolve the native library from. */
  packageName: string;
  workerName: string;
  nativeLib: string;
  nativeAddon: string;
  /** `lipo -thin` name. Set when the worker archive is a universal Mach-O. */
  lipo?: string;
  /** Tar member to pull out of the worker archive. Zip archives are searched instead. */
  workerMember?: string;
  artifacts: CuaArtifact[];
};

function artifact(kind: CuaArtifactKind, filename: string, sha256: string): CuaArtifact {
  return { kind, filename, sha256, url: `${RELEASE}/${filename}` };
}

/**
 * Artifacts for this OS and CPU, or null when computer control is not offered here.
 *
 * Linux is unsupported (compositor-specific helpers this app does not ship). An
 * architecture outside the published matrix is the same answer: there is nothing
 * to download.
 */
export function cuaPlatformSpec(platform: string, arch: string): CuaPlatformSpec | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const triple = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    return {
      version: CUA_DRIVER_VERSION,
      packageName: `@trycua/cua-driver-${triple}`,
      workerName: "cua-driver",
      nativeLib: "libcua_driver_sdk.dylib",
      nativeAddon: "cua_driver_node_runtime.node",
      lipo: arch === "arm64" ? "arm64" : "x86_64",
      workerMember: "cua-driver",
      artifacts: [
        artifact(
          "worker",
          `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
          "386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa",
        ),
        artifact(
          "native",
          `trycua-cua-driver-${triple}-${CUA_DRIVER_VERSION}.tgz`,
          arch === "arm64"
            ? "9dbc79870dc367acbee20c86dee34794e77883e5d5d4b440260652d9341098cb"
            : "f7b671148c06a3c764ceaef1ee58ea39385f3f7ed5416833948a64b9e47c37b6",
        ),
      ],
    };
  }
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    const triple = arch === "arm64" ? "win32-arm64-msvc" : "win32-x64-msvc";
    const winArch = arch === "arm64" ? "arm64" : "x86_64";
    return {
      version: CUA_DRIVER_VERSION,
      packageName: `@trycua/cua-driver-${triple}`,
      workerName: "cua-driver.exe",
      nativeLib: "cua_driver_sdk.dll",
      nativeAddon: "cua_driver_node_runtime.node",
      artifacts: [
        artifact(
          "worker",
          `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-${winArch}-binary.zip`,
          arch === "arm64"
            ? "578b88ff2dd56f06eb7e984d73aaf5e76f59c6fde9542c967d6a30d00213c680"
            : "1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba",
        ),
        artifact(
          "native",
          `trycua-cua-driver-${triple}-${CUA_DRIVER_VERSION}.tgz`,
          arch === "arm64"
            ? "a5791af3321933bd818b8a37cbd988480bf1b733e332f6669da2e7d29d820676"
            : "731a3e5d7307ea535a74df4dca806826b9b53a723b3f137ecf7d940f585b982a",
        ),
      ],
    };
  }
  return null;
}

export function cuaMirrorUrl(url: string): string {
  return `${CUA_GITHUB_MIRROR}${url}`;
}

export type CuaInstallLayout = {
  root: string;
  worker: string;
  nativeDir: string;
  packageName: string;
};

export function cuaInstallLayout(root: string, spec: CuaPlatformSpec): CuaInstallLayout {
  return {
    root,
    worker: `${root}/${spec.workerName}`,
    nativeDir: `${root}/native`,
    packageName: spec.packageName,
  };
}
