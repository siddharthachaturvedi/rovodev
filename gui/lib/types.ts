export type SessionSummary = {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  folderPath?: string;
  latestResult?: string;
  numMessages?: number;
  parentSessionId?: string;
};

export type ServerHealth = {
  status: string;
  version?: string;
  mcp_servers?: Record<string, string>;
};

export type ChatRequest = {
  sessionId: string;
  message: string;
  enableDeepPlan: boolean;
  yoloMode: boolean;
  model: string;
};

export type UiStatus = {
  health: ServerHealth | null;
  usage: unknown;
  toolsCount: number;
  userLabel: string;
  accountId?: string | null;
  currentMode?: string | null;
  currentModelName?: string | null;
  currentModelId?: string | null;
  availableModes?: string[];
  availableModels?: Array<{ id: string; name: string }>;
};
