package db

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// pi 会话文件存储在 ~/.pi/agent/sessions/--<工作目录>--/*.jsonl，
// 每条 message 行里的 assistant 消息带 usage 字段（token 用量与费用）。
// 路径搜索顺序：PI_HOME > ~/.pi/agent/sessions
func piSessionDir() string {
	if p := os.Getenv("PI_HOME"); p != "" {
		return filepath.Join(p, "agent", "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent", "sessions")
}

// piFileStamp 记录 pi 会话文件的 (size, mtime)，用于增量跳过未变化的文件
type piFileStamp struct {
	size  int64
	mtime int64
}

type piEntry struct {
	Type      string `json:"type"`
	Message   struct {
		Role      string   `json:"role"`
		Provider  string   `json:"provider"`
		Model     string   `json:"model"`
		Usage     piUsage  `json:"usage"`
		Timestamp int64    `json:"timestamp"`
	} `json:"message"`
	// 会话头所在行
	Cwd       string `json:"cwd"`
	Timestamp string `json:"timestamp"`
}

type piUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// loadPiRecords 扫描 pi 会话目录下所有 jsonl，提取 assistant 消息的用量记录。
func loadPiRecords() []UsageRecord {
	dir := piSessionDir()
	if dir == "" {
		return nil
	}
	var out []UsageRecord
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		out = append(out, parsePiFile(path)...)
		return nil
	})
	return out
}

// parsePiFile 解析单个 pi 会话文件，返回该文件的 assistant 用量记录。
// 会话头行（type=session）提供 cwd 作为项目名。
func parsePiFile(path string) []UsageRecord {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var records []UsageRecord
	project := ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		var e piEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		switch e.Type {
		case "session":
			if e.Cwd != "" {
				project = e.Cwd
			}
			continue
		case "message":
			// 只统计 assistant 消息（pi 的 toolResult 也可能带 usage，暂不纳入）
			if e.Message.Role != "assistant" {
				continue
			}
		default:
			continue
		}
		u := e.Message.Usage
		if u.Input+u.Output+u.Reasoning+u.CacheRead+u.CacheWrite == 0 {
			continue
		}
		if project == "" {
			project = "pi"
		}
		createdAt := e.Message.Timestamp
		if createdAt <= 0 {
			if t, err := time.Parse(time.RFC3339Nano, e.Timestamp); err == nil {
				createdAt = t.UnixMilli()
			}
		}
		rec := UsageRecord{
			Agent:            "pi",
			Provider:         fallback(e.Message.Provider, "unknown"),
			Model:            fallback(e.Message.Model, "unknown"),
			Project:          project,
			InputTokens:      u.Input,
			OutputTokens:     u.Output,
			ReasoningTokens:  u.Reasoning,
			CacheReadTokens:  u.CacheRead,
			CacheWriteTokens: u.CacheWrite,
			CacheHitRate:     calcHitRate(u.Input, u.CacheRead),
			CreatedAt:        createdAt,
		}
		records = append(records, rec)
	}
	return records
}
