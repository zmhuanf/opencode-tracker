export interface UsageRecord {
  agent: string;
  provider: string;
  model: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  cacheHitRate: number;
  durationMs: number;
  speed: number;
  createdAt: number;
}

export interface Summary {
  total: number;
  inputTokens: number;
  outputTokens: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate: number;
}

export interface UsageFilter {
  start: number;
  end: number;
  agent: string;
  provider: string;
  model: string;
}

export interface UsageQuery extends UsageFilter {
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

export interface Pricing {
  input: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  cacheWrite: number;
  multiplier: number;
  peakMultiplier: number;
  peakTimes: string[];
  peakDates: string[];
}

export type PricingMap = Record<string, Pricing>;

export interface PricingSaveReq {
  key: string;
  pricing: Pricing;
}
