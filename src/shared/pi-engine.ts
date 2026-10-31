export type PiEngineMode = "isolated" | "global";

export type PiEngineState = {
  mode: PiEngineMode;
  agentDir: string;
  globalAgentDir: string;
  isolatedAgentDir: string;
};

export type PiEngineSwitchResult = PiEngineState & {
  backupDir: string;
  restartRequired: boolean;
};
