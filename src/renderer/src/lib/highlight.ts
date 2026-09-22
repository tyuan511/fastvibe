import { useEffect, useMemo, useRef, useState } from "react";
import { StreamingHighlighter } from "./syntax-highlighter";

/** Bounded by approximate UTF-16 bytes, including the exact source in the key. */
const CACHE_BYTES = 8_000_000;
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;

function remember(key: string, html: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.bytes;
  const bytes = (key.length + html.length) * 2;
  cache.set(key, { html, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)?.bytes ?? 0;
    cache.delete(oldest);
  }
}

function forget(key: string): void {
  const existing = cache.get(key);
  if (!existing) return;
  cacheBytes -= existing.bytes;
  cache.delete(key);
}

interface Highlight {
  code: string;
  language?: string;
  html: string;
}

/**
 * Shiki's stream tokenizer reuses completed lines instead of re-highlighting the
 * entire growing block. Keep the previous highlight until its appended suffix is
 * ready; never clear it per token or wait for a quiet debounce window. A different
 * file/language must not show the old file's HTML while its grammar loads.
 * The caller must also keep its React component identity stable across tokens.
 */
export function useHighlightedCode(code: string, language?: string): string | null {
  const key = `${language ?? ""}\u0000${code}`;
  const highlighter = useMemo(() => new StreamingHighlighter(language), [language]);
  const [result, setResult] = useState<Highlight | null>(() => {
    const cached = cache.get(key);
    return cached ? { code, language, html: cached.html } : null;
  });
  /**
   * The key this block was last remembered under.
   *
   * A fence that is still streaming is remembered once per flush, each time at its
   * full length — so a 10 KB block arriving over a few hundred flushes wrote tens of
   * megabytes through an 8 MB cache and evicted every other block on the way, which
   * is why scrolling back over an older answer re-highlighted it. The shorter
   * prefixes are worth nothing once the longer text is in, so each is dropped as it
   * is superseded and only the newest length of the block stays.
   */
  const remembered = useRef<string | null>(null);

  useEffect(() => {
    // This length of the block is now the one worth keeping: drop the shorter prefix
    // it grew out of. `startsWith` covers the whole key, separator included, so a
    // different language (`ts` against `tsx`) is never mistaken for the same block.
    const supersede = (): void => {
      const previous = remembered.current;
      if (previous !== null && previous !== key && key.startsWith(previous)) forget(previous);
      remembered.current = key;
    };
    const cached = cache.get(key);
    if (cached) {
      supersede();
      setResult({ code, language, html: cached.html });
      return;
    }
    let active = true;
    highlighter.highlight(code).then((html) => {
      if (!active) return;
      remember(key, html);
      supersede();
      setResult({ code, language, html });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [key, code, language, highlighter]);

  return result && result.language === language && code.startsWith(result.code) ? result.html : null;
}
