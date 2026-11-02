const CUA_ENUMS: Record<string, string[]> = {
  effect: ["Confirmed", "Partial", "Unverifiable", "SuspectedNoop", "Refused"],
  route: ["Accessibility", "SyntheticEvents", "GlobalInput", "SystemApi", "Dom", "TrustedInput"],
  mode: ["Background", "Foreground", "NotApplicable", "Unknown"],
  target: ["Pixel", "Foreground", "Page", "Session"],
  reason: ["RouteUnavailable", "DeliveryFailed", "EffectUnconfirmed", "SuspectedNoop", "PermissionRequired"],
  status: ["Satisfied", "Unsatisfied", "Unknown"],
  unknownReason: ["InvalidPredicate", "UnsupportedPredicate", "UntrustedSource", "MultiMatch", "TargetMissing", "ObservationUnavailable", "StabilityUnproven"],
  kind: ["ValueReadback", "WindowChange"],
};

export type CuaModelMetadata = {
  degraded?: boolean;
  errorCode?: string;
  action?: unknown;
  verification?: unknown;
};

export function normalizeCuaMetadata(value: unknown, key?: string): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalizeCuaMetadata(item, key));
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && key && CUA_ENUMS[key]?.[value] !== undefined) return CUA_ENUMS[key][value];
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeCuaMetadata(item, name)]));
}

export function parseCuaJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Build the part of a CUA result the model can act on. `details` is renderer/session
 * metadata in pi; it is not part of the provider content, so structured observations and
 * action verdicts must be included here too.
 */
export function modelCuaResultText(text: string, structuredJson?: string, metadata?: CuaModelMetadata): string {
  const modelMetadata = {
    ...(structuredJson !== undefined ? { structured: normalizeCuaMetadata(parseCuaJson(structuredJson)) } : {}),
    ...(metadata?.degraded ? { degraded: true } : {}),
    ...(metadata?.errorCode ? { errorCode: metadata.errorCode } : {}),
    ...(metadata?.action !== undefined ? { action: normalizeCuaMetadata(metadata.action) } : {}),
    ...(metadata?.verification !== undefined ? { verification: normalizeCuaMetadata(metadata.verification) } : {}),
  };
  if (Object.keys(modelMetadata).length === 0) return text;
  return `${text}\n\n[CUA structured result]\n${JSON.stringify(modelMetadata, jsonReplacer, 2)}`;
}
