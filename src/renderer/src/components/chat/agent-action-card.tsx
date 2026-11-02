import { Trans, useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, BotIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import type { ChatMessage, ToolCallBlock } from "@shared/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { agentToolAction, agentToolTargets } from "@/lib/agent-tool";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { useTranscriptConversation } from "./conversation-context";
import { ToolRow } from "./tool-row";

const EMPTY_MESSAGES: ChatMessage[] = [];

/** Identity links and the details toggle are siblings: no buttons inside a trigger. */
export function AgentActionCard({ tool, showIcon, children }: {
  tool: ToolCallBlock; showIcon: boolean; children: ReactNode;
}) {
  const { t } = useTranslation("common");
  const conversationId = useTranscriptConversation();
  const messages = useSessionStore((state) => state.activeId === conversationId ? state.messages : EMPTY_MESSAGES);
  const registry = useSessionStore((state) => state.subagents);
  const agents = agentToolTargets(tool, conversationId, messages, registry);
  const action = agentToolAction(tool.name)!;
  const phase = tool.status === "running" ? "running" : tool.status === "error" ? "error" : "done";
  const identities = agents.length ? agents.map((agent) => (
    <button
      key={agent.id}
      type="button"
      className="mx-1 inline-flex max-w-full cursor-pointer items-center gap-1 align-middle text-foreground [-webkit-text-fill-color:currentColor] underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      title={agent.name ?? agent.id}
      onClick={() => useSidePaneStore.getState().openSubagent(agent.id, {
        conversationId: conversationId ?? undefined, title: agent.name ?? t("tool.agentUnnamed"), avatarSeed: agent.avatarSeed,
      })}
    >
      {agent.avatarSeed !== undefined ? <AgentAvatar seed={agent.avatarSeed} size="size-4" /> : <HugeiconsIcon icon={BotIcon} className="size-3.5 shrink-0" />}
      <span className="truncate">{agent.name ?? t("tool.agentUnnamed")}</span>
    </button>
  )) : <span className="mx-1">{t(action === "spawn" ? "tool.agentNew" : "tool.agentTeam")}</span>;

  return (
    <Collapsible className="group/agent-action w-full">
      <ToolRow
        persistKey={tool.id}
        icon={phase === "running" ? <Spinner className="size-3" /> : <HugeiconsIcon icon={BotIcon} className="size-3.5" />}
        label={<Trans ns="common" i18nKey={`tool.agentAction.${action}.${phase}`} components={{ agents: <span>{identities}</span> }} />}
        running={phase === "running"}
        error={phase === "error" ? tool.result ?? t("tool.failed") : undefined}
        showIcon={showIcon}
        quiet
        canToggle={false}
        trailing={
          <CollapsibleTrigger
            className="shrink-0 cursor-pointer rounded-sm text-muted-foreground opacity-0 group-hover/agent-action:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100 group-data-open/agent-action:opacity-100"
            aria-label={t("tool.agentDetails")}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5 transition-transform group-data-open/agent-action:rotate-90" />
          </CollapsibleTrigger>
        }
      />
      <CollapsibleContent className="pt-2">
        <div className="ml-2 flex flex-col gap-2 border-l border-border pl-3.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
