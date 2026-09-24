/**
 * How a transcript is drawn.
 *
 * 折叠运行过程、显示思考过程、显示消息时间 used to be toggles under 设置 → 对话.
 * They are not preferences anymore: a finished run always folds, and thinking and
 * timestamps always show. `setTranscriptDisplay` exists only for the preview harness
 * — 官网截图 hides timestamps and leaves the demo run unfolded.
 */
export type TranscriptDisplay = {
  showThinking: boolean;
  showTimestamp: boolean;
  collapseRuns: boolean;
};

const PRODUCT: TranscriptDisplay = {
  showThinking: true,
  showTimestamp: true,
  collapseRuns: true,
};

let current: TranscriptDisplay = PRODUCT;

export function transcriptDisplay(): TranscriptDisplay {
  return current;
}

/** Preview harness only. Production never calls this. */
export function setTranscriptDisplay(patch: Partial<TranscriptDisplay>): void {
  current = { ...current, ...patch };
}
