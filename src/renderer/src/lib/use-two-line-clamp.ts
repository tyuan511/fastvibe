import { useLayoutEffect, useRef, useState } from "react";

/** Measure the same two rendered lines for prompts and pasted-content previews. */
export function useTwoLineClamp(text: string) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [text]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;

    const measure = (): void => {
      if (expanded) {
        const style = getComputedStyle(node);
        const lineHeight = Number.parseFloat(style.lineHeight);
        const cap = (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24) * 2;
        const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        setOverflows(node.scrollHeight - padding > cap + 1);
        return;
      }
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

  return { expanded, setExpanded, overflows, bodyRef };
}
