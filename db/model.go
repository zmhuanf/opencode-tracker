package db

type UsageRecord struct {
	Provider         string  `json:"provider"`
	Model            string  `json:"model"`
	Project          string  `json:"project"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	Cost             float64 `json:"cost"`
	CacheHitRate     float64 `json:"cacheHitRate"`
	DurationMs       int64   `json:"durationMs"`
	Speed            float64 `json:"speed"`
	CreatedAt        int64   `json:"createdAt"`
}

type Summary struct {
	Total        int64   `json:"total"`
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	CacheRead    int64   `json:"cacheRead"`
	CacheWrite   int64   `json:"cacheWrite"`
	Cost         float64 `json:"cost"`
	CacheHitRate float64 `json:"cacheHitRate"`
}

type UsageQuery struct {
	Start    int64  `json:"start"`
	End      int64  `json:"end"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

type UsageResponse struct {
	List    []UsageRecord `json:"list"`
	Summary Summary       `json:"summary"`
	Total   int64         `json:"total"`
	Page    int           `json:"page"`
	PageSize int          `json:"pageSize"`
}
