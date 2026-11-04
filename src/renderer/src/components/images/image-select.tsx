import type { JSX } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function ImageSelect({ value, onChange, options, label, disabled, className }: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  return <Select items={Object.fromEntries(options.map((option) => [option.value, option.label]))} value={value} onValueChange={(next) => { if (next !== null) onChange(next); }} disabled={disabled}>
    <SelectTrigger aria-label={label} title={selectedLabel} className={className}><SelectValue>{selectedLabel}</SelectValue></SelectTrigger>
    <SelectContent side="top" align="start" alignItemWithTrigger={false} className="w-max min-w-(--anchor-width) max-w-[min(32rem,calc(100vw-2rem))]">
      {options.map((option) => <SelectItem key={option.value} value={option.value} title={option.label} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
