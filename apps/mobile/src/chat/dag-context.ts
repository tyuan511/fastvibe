import { createContext } from "react";

/** Kept separate from the sheet so execution transcripts can render tool cards without a cycle. */
export const DagContext = createContext<{ open: (nodeId?: string) => void } | null>(null);
