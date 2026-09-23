import { APP_CAPABILITIES, intersectCapabilities, type AppCapability } from "../../shared/app-protocol.ts";
import { remotePolicy } from "../../shared/remote-policy.ts";

function capabilityOf(method: string): AppCapability | null {
  if (method.startsWith("engine:")) return "engine";
  if (method.startsWith("conversations:")) return "conversations";
  if (method.startsWith("projects:")) return "conversations";
  if (method.startsWith("workspace:terminal")) return "terminal";
  if (method.startsWith("workspace:git")) return "git";
  if (method.startsWith("workspace:")) return "workspace";
  if (method.startsWith("providers:")) return "providers";
  if (method.startsWith("models-dev:")) return "providers";
  if (method.startsWith("settings:")) return "settings";
  if (method.startsWith("decision:")) return "settings";
  if (method.startsWith("memory:")) return "settings";
  if (method.startsWith("stats:")) return "stats";
  if (method.startsWith("app:")) return "settings";
  if (method.startsWith("update:")) return "native";
  if (method.startsWith("window:")) return "native";
  if (method.startsWith("browser:")) return "browser";
  if (method.startsWith("computer:")) return "native";
  if (method.startsWith("system:")) return "native";
  if (method.startsWith("remote:")) return null;
  if (method.startsWith("ssh:")) return null;
  return null;
}

export function capabilityFor(method: string): AppCapability | null {
  return capabilityOf(method);
}

export const DESKTOP_CAPABILITIES: readonly AppCapability[] = APP_CAPABILITIES;

export const HEADLESS_CAPABILITIES: readonly AppCapability[] = APP_CAPABILITIES.filter(
  (capability) => capability !== "browser" && capability !== "native",
);

const ADMINISTRATIVE_PREFIXES = ["remote:", "ssh:"] as const;

export type CallerKind = "window" | "remote";

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string; code: string };

export type PolicyOptions = {
  caller: CallerKind;
  serverCapabilities: readonly AppCapability[];
  /** Already-intersected or raw client declaration; intersected again with the server. */
  clientCapabilities?: readonly AppCapability[] | null;
};

export function isAdministrative(method: string): boolean {
  return ADMINISTRATIVE_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function effectiveCapabilities(options: PolicyOptions): AppCapability[] {
  return intersectCapabilities(options.serverCapabilities, options.clientCapabilities);
}

/**
 * Layer `remote-policy.ts` under capabilities.
 *
 * Local windows are permitted everything, including admin (`remote:*` / `ssh:*`).
 * Remote callers never relax native-dialog, provider-fetch, or admin denials — a
 * client declaration cannot grant those. Remaining methods still need a capability
 * the server actually offers (and the client declared, if it declared any).
 */
export function authorize(method: string, options: PolicyOptions): PolicyVerdict {
  if (options.caller === "window") return { allowed: true };

  const policy = remotePolicy(method);
  if (!policy.allowed) {
    return {
      allowed: false,
      code: isAdministrative(method) ? "policy.administrative" : "policy.denied",
      reason: policy.reason,
    };
  }

  const capability = capabilityOf(method);
  if (!capability) {
    return { allowed: false, code: "policy.unclassified", reason: "该方法未开放给远程客户端" };
  }

  const effective = effectiveCapabilities(options);
  if (!effective.includes(capability)) {
    return {
      allowed: false,
      code: "capability.unsupported",
      reason: reasonForMissingCapability(capability),
    };
  }
  return { allowed: true };
}

export function authorizePush(channel: string, options: PolicyOptions): boolean {
  if (options.caller === "window") return true;
  if (isAdministrative(channel)) return false;
  const capability = capabilityOf(channel);
  if (!capability) return false;
  return effectiveCapabilities(options).includes(capability);
}

function reasonForMissingCapability(capability: AppCapability): string {
  switch (capability) {
    case "browser":
      return "浏览器工具依赖桌面端的内嵌浏览器";
    case "native":
      return "该操作需要桌面窗口或本机系统能力";
    default:
      return `远程 App Server 不支持「${capability}」能力`;
  }
}

export function assertCapabilityCoverage(channels: readonly string[]): void {
  const unclassified = channels.filter((channel) => capabilityOf(channel) === null && !isAdministrative(channel));
  if (unclassified.length > 0) {
    throw new Error(`App Server 能力覆盖检查失败：\n- 未分类的方法：${unclassified.join(", ")}`);
  }
}
