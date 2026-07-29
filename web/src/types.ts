export interface UsageRecord {
  provider: string;
  model: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  createdAt: number;
}

export interface Summary {
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate: number;
}

export interface UsageQuery {
  start: string;
  end: string;
  provider: string;
  model: string;
  page: number;
  pageSize: number;
}

export interface UsageResponse {
  list: UsageRecord[];
  summary: Summary;
  total: number;
  page: number;
  pageSize: number;
}
