import { Type } from "typebox";
import type { Api, Model, Context, AssistantMessageEventStream, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProviderTestError, ProviderTestResult } from "../../shared/provider-test.ts";

type Stream = (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => AssistantMessageEventStream;

/** Errors are classified locally. Provider bodies, headers and credentials never reach the UI. */
export function providerTestError(status: number | undefined, message: string): ProviderTestError {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 404 || status === 405 || status === 400 || status === 422) return "protocol";
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/401|403|unauthorized|authentication|invalid.*key/i.test(message)) return "auth";
  if (/429|rate.limit/i.test(message)) return "rate-limit";
  if (/fetch|network|connect|ENOTFOUND|ECONN|TLS|socket/i.test(message)) return "network";
  return "unknown";
}

/** Two bounded, isolated calls. The tool is a schema probe and is never executed. */
export async function testProviderModel(model: Model<Api>, stream: Stream): Promise<ProviderTestResult> {
  const started = Date.now();
  const result: ProviderTestResult = { model: model.id, api: model.api, status: "failed", elapsedMs: 0, tools: "not-tested" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let responseStatus: number | undefined;
  try {
    const options: ModelsSimpleStreamOptions = {
      signal: controller.signal, timeoutMs: 20_000, maxRetries: 0, maxTokens: 256, cacheRetention: "none",
      onResponse: (response) => { responseStatus = response.status; },
    };
    let answered = false;
    for await (const event of stream(model, { messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] }, options)) {
      if (event.type === "text_delta" && event.delta) {
        result.firstTokenMs ??= Date.now() - started;
        answered = true;
      }
      if (event.type === "error") throw new Error(event.error.errorMessage ?? event.reason);
      if (event.type === "done") answered ||= event.message.content.some((part) => part.type === "text" && Boolean(part.text));
    }
    if (!answered) throw new Error("Empty response");
    result.status = "partial";
    result.tools = "unconfirmed";
    responseStatus = undefined;
    for await (const event of stream(model, {
      messages: [{ role: "user", content: "Call fastvibe_probe once with value equal to ok. Do not answer in text.", timestamp: Date.now() }],
      tools: [{ name: "fastvibe_probe", description: "A harmless connectivity test. No action will be performed.", parameters: Type.Object({ value: Type.Literal("ok") }) }],
    }, options)) {
      if (event.type === "error") { result.tools = "failed"; throw new Error(event.error.errorMessage ?? event.reason); }
      if (event.type === "done" && event.message.content.some((part) => part.type === "toolCall" && part.name === "fastvibe_probe" && part.arguments.value === "ok")) {
        result.tools = "passed";
        result.status = "passed";
      }
    }
  } catch (error) {
    result.errorCode = controller.signal.aborted ? "timeout" : providerTestError(responseStatus, String(error));
  } finally {
    clearTimeout(timer);
    controller.abort();
    result.elapsedMs = Date.now() - started;
  }
  return result;
}
