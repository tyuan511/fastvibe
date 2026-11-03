import { describeAssistantError } from "../../../shared/assistant-error.ts";

export type ViviFeedbackAction = "load" | "send" | "stop" | "answer" | "execution";
type Reason = ViviFeedbackAction | "auth" | "quota" | "rateLimit" | "network" | "permission" | "paused" | "questionExpired" | "pendingQuestion";

/** Main-chat copy is a short, translated conclusion; raw diagnostics stay in state/details. */
export function viviFeedbackKey(cause: unknown, action: ViviFeedbackAction): `viviBot.feedback.${Reason}` {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const text = raw.trim();
  let reason: Reason = action;
  // These are host validation messages, not arbitrary provider prose.
  if (text === "会话已暂停，请先继续") reason = "paused";
  else if (text === "这个问题已处理或过期") reason = "questionExpired";
  else if (text === "请先回答当前问题。" || text === "Please answer the pending question first.") reason = "pendingQuestion";
  else {
    const { status, code } = describeAssistantError(text);
    if (code && /^(?:insufficient_quota|quota_exceeded|insufficient_balance)$/i.test(code)) reason = "quota";
    else if (status === 401 || code === "authentication_error" || code === "invalid_api_key") reason = "auth";
    else if (status === 429 || code === "rate_limit_error") reason = "rateLimit";
    else if (status === 502 || status === 503 || status === 504 || /^(?:Connection error\.?|fetch failed|Failed to fetch|Network request failed)$/i.test(text)) reason = "network";
    else if (/^(?:EACCES|EPERM)\b/.test(text)) reason = "permission";
  }
  return `viviBot.feedback.${reason}`;
}
