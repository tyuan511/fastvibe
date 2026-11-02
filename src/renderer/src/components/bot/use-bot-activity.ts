import { useEffect, useState } from "react";
import type { BotActivity } from "@shared/bot";

/** Sidebar subscription deliberately never loads a transcript. */
export function useBotActivity(): BotActivity | null {
  const [activity, setActivity] = useState<BotActivity | null>(null);
  useEffect(() => {
    let alive = true;
    let received = false;
    const off = window.fastvibe.bot.onChanged((event) => {
      if (!alive || !event.activity) return;
      received = true;
      setActivity(event.activity);
    });
    void window.fastvibe.bot.getActivity().then((initial) => {
      if (alive && !received) setActivity(initial);
    }).catch(() => undefined);
    return () => { alive = false; off(); };
  }, []);
  return activity;
}
