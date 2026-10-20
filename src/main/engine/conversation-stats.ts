import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelPrice, SessionStats } from "../../shared/types.ts";
import { priceUsage } from "./pricing.ts";
import { emptyTokenTotals } from "./turn-usage.ts";

/** Whole-file statistics, matching the SDK's scope without initializing an agent. */
export function conversationStats(
  entries: readonly SessionEntry[],
  priceFor: (provider: string, model: string) => ModelPrice | undefined,
): SessionStats {
  const tokens = emptyTokenTotals();
  let rounds = 0;
  let steps = 0;
  let toolCalls = 0;
  let cost = 0;
  for (const entry of entries) {
    let usage;
    let price: ModelPrice | undefined;
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") rounds++;
      if (message.role === "assistant") {
        steps++;
        toolCalls += message.content.filter((part) => part.type === "toolCall").length;
        usage = message.usage;
        price = priceFor(message.provider, message.model);
      } else if (message.role === "toolResult") {
        usage = message.usage;
      }
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      usage = entry.usage;
    }
    if (!usage) continue;
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    cost += priceUsage(price ?? {}, usage) ?? usage.cost?.total ?? 0;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { rounds, steps, toolCalls, tokens, cost };
}
