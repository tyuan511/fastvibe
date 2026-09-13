import { memo, useEffect, useRef, useState, type JSX } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { formatElapsed } from "@/lib/time";
import { cn } from "@/lib/utils";

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  active,
}: {
  thinking: string;
  active: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(active);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) {
      setOpen(true);
      startedAt.current = Date.now();
      setElapsed(0);
      const timer = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      }, 1000);
      return () => window.clearInterval(timer);
    }
    setOpen(false);
    return undefined;
  }, [active]);

  useEffect(() => {
    if (active && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thinking, active, open]);

  const label = active ? `思考中 · ${formatElapsed(elapsed)}` : elapsed > 0 ? `思考完成 · ${formatElapsed(elapsed)}` : "思考过程";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground">
        {active ? <Spinner className="size-3" /> : <Brain className="size-3.5" />}
        <span>{label}</span>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={bodyRef}
          className="mt-1.5 max-h-48 max-w-2xl overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 whitespace-pre-wrap text-[11.5px] leading-5 text-muted-foreground select-text"
        >
          {thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
