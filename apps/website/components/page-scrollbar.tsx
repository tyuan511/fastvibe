"use client";

import { useEffect, useRef } from "react";

/**
 * A thumb drawn over the page. The native scrollbar is hidden in CSS, because showing one
 * always reserves a column and the page would no longer reach the window edge.
 */
export function PageScrollbar() {
  const thumb = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const bar = thumb.current;
    if (!bar) return;
    let hide = 0;
    const place = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) {
        bar.style.display = "none";
        return;
      }
      bar.style.display = "";
      const span = window.innerHeight;
      const height = Math.max(44, (span / document.documentElement.scrollHeight) * span);
      bar.style.height = `${height}px`;
      bar.style.top = `${(window.scrollY / scrollable) * (span - height)}px`;
    };
    const show = () => {
      document.documentElement.classList.add("scrollbar-live");
      window.clearTimeout(hide);
      hide = window.setTimeout(() => document.documentElement.classList.remove("scrollbar-live"), 700);
    };
    const onScroll = () => { place(); show(); };
    let drag: { y: number; top: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { y: event.clientY, top: window.scrollY };
      bar.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const travel = window.innerHeight - bar.offsetHeight;
      if (travel <= 0) return;
      window.scrollTo(0, drag.top + ((event.clientY - drag.y) / travel) * scrollable);
    };
    const onPointerUp = () => { drag = null; };
    place();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", place);
    bar.addEventListener("pointerdown", onPointerDown);
    bar.addEventListener("pointermove", onPointerMove);
    bar.addEventListener("pointerup", onPointerUp);
    return () => {
      window.clearTimeout(hide);
      document.documentElement.classList.remove("scrollbar-live");
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", place);
      bar.removeEventListener("pointerdown", onPointerDown);
      bar.removeEventListener("pointermove", onPointerMove);
      bar.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  return (
    <div className="page-scrollbar" aria-hidden="true">
      <span ref={thumb} />
    </div>
  );
}
