"use client";

import { useEffect } from "react";
import { REVEAL_SELECTOR } from "@/lib/reveal";

/** Marks each section's pieces `data-in` the first time they scroll into view; the CSS does the rest. */
export function ScrollReveal() {
  useEffect(() => {
    if (!document.documentElement.classList.contains("reveal")) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-in", "");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    document.querySelectorAll(REVEAL_SELECTOR).forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  return null;
}
