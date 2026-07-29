package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

type rawMessage struct {
	TimeCreated int64  `json:"-"`
	TimeUpdated int64  `json:"-"`
	Project     string `json:"-"`
	Role        string `json:"role"`
	ProviderID  string `json:"providerID"`
	ModelID     string `json:"modelID"`
	Cost        float64 `json:"cost"`
	Tokens      struct {
		Input  int64 `json:"input"`
		Output int64 `json:"output"`
		Cache  struct {
			Read  int64 `json:"read"`
			Write int64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
	Time struct {
		Created   int64 `json:"created"`
		Completed int64 `json:"completed"`
	} `json:"time"`
}

type queryRow struct {
	TimeCreated int64
	TimeUpdated int64
	Project     sql.NullString
	Data        string
}

// fetchSince 从 conn 拉取 time_created/updated >= sinceMs 的消息行。
// useUpdated 控制用哪一列做增量水位。
func fetchSince(conn *sql.DB, sinceMs int64, useUpdated bool) ([]queryRow, error) {
	col := "time_created"
	if useUpdated {
		col = "time_updated"
	}
	q := fmt.Sprintf(`
		SELECT m.time_created, m.time_updated, s.project_id, m.data
		FROM message m
		LEFT JOIN session s ON s.id = m.session_id
		WHERE m.%s >= ?
	`, col)
	rows, err := conn.Query(q, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []queryRow
	for rows.Next() {
		var r queryRow
		if err := rows.Scan(&r.TimeCreated, &r.TimeUpdated, &r.Project, &r.Data); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// parseMessage 把 data 列 JSON 解码为标准化 UsageRecord。
// 只保留 assistant 角色且 token 字段齐全的消息。
func parseMessage(row queryRow) (UsageRecord, bool) {
	var msg rawMessage
	if err := json.Unmarshal([]byte(row.Data), &msg); err != nil {
		return UsageRecord{}, false
	}
	if msg.Role != "assistant" {
		return UsageRecord{}, false
	}
	tokens := msg.Tokens.Input + msg.Tokens.Output + msg.Tokens.Cache.Read + msg.Tokens.Cache.Write
	if tokens == 0 && msg.Cost == 0 {
		return UsageRecord{}, false
	}
	project := row.Project.String
	if project == "" {
		project = "default"
	}
	rec := UsageRecord{
		Provider:         fallback(msg.ProviderID, "unknown"),
		Model:            fallback(msg.ModelID, "unknown"),
		Project:          project,
		InputTokens:      msg.Tokens.Input,
		OutputTokens:     msg.Tokens.Output,
		CacheReadTokens:  msg.Tokens.Cache.Read,
		CacheWriteTokens: msg.Tokens.Cache.Write,
		Cost:             msg.Cost,
		CacheHitRate:     calcHitRate(msg.Tokens.Input, msg.Tokens.Cache.Read),
		CreatedAt:        row.TimeCreated,
	}
	if msg.Time.Completed > msg.Time.Created {
		rec.DurationMs = msg.Time.Completed - msg.Time.Created
		if rec.OutputTokens > 0 {
			rec.Speed = float64(rec.OutputTokens) / float64(rec.DurationMs) * 1000
		}
	}
	return rec, true
}

func fallback(s, fb string) string {
	if strings.TrimSpace(s) == "" {
		return fb
	}
	return s
}

// 缓存命中率定义：缓存读取占"已计费输入"（input + cache.read）的比例。
// 反映有多少原本要计费的输入被缓存覆盖。
func calcHitRate(input, cacheRead int64) float64 {
	denom := input + cacheRead
	if denom <= 0 {
		return 0
	}
	return float64(cacheRead) / float64(denom) * 100
}
