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
  return <Select value={value} onValueChange={(next) => { if (next !== null) onChange(next); }} disabled={disabled}>
    <SelectTrigger aria-label={label} className={className}><SelectValue>{options.find((option) => option.value === value)?.label ?? value}</SelectValue></SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false}>
      {options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
