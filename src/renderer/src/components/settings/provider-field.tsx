import type { JSX } from "react";
import { Label } from "@/components/ui/label";

export function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
