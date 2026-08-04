package db

type UsageRecord struct {
	Agent            string  `json:"agent"`
	Provider         string  `json:"provider"`
	Model            string  `json:"model"`
	Project          string  `json:"project"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	ReasoningTokens  int64   `json:"reasoningTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	Cost             float64 `json:"cost"`
	CacheHitRate     float64 `json:"cacheHitRate"`
	FirstTokenMs     int64   `json:"firstTokenMs"`
	FirstTextMs      int64   `json:"firstTextMs"`
	DurationMs       int64   `json:"durationMs"`
	Speed            float64 `json:"speed"`
	CreatedAt        int64   `json:"createdAt"`
}

type Summary struct {
	Total        int64   `json:"total"`
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	Reasoning    int64   `json:"reasoning"`
	CacheRead    int64   `json:"cacheRead"`
	CacheWrite   int64   `json:"cacheWrite"`
	Cost         float64 `json:"cost"`
	CacheHitRate float64 `json:"cacheHitRate"`
}

type UsageQuery struct {
	Start    int64  `json:"start"`
	End      int64  `json:"end"`
	Agent    string `json:"agent"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

type UsageResponse struct {
	List     []UsageRecord `json:"list"`
	Summary  Summary       `json:"summary"`
	Total    int64         `json:"total"`
	Page     int           `json:"page"`
	PageSize int           `json:"pageSize"`
}
