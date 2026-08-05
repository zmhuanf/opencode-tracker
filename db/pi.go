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
	Type    string `json:"type"`
	Message struct {
		Role      string  `json:"role"`
		Provider  string  `json:"provider"`
		Model     string  `json:"model"`
		Usage     piUsage `json:"usage"`
		Timestamp int64   `json:"timestamp"`
	} `json:"message"`
	// pi-plugin 写入的 timing custom entry（customType=pi-tracker/timing）
	CustomType string          `json:"customType"`
	Data       json.RawMessage `json:"data"`
	// 会话头所在行
	Cwd       string `json:"cwd"`
	Timestamp string `json:"timestamp"`
}

// piTiming 是 pi-plugin 在每条 assistant 消息结束时写入的计时数据。
// start 与 messageTimestamp 都取自请求开始时刻（毫秒），可用来和用量记录关联。
type piTiming struct {
	MessageTimestamp int64 `json:"messageTimestamp"`
	Start            int64 `json:"start"`
	FirstToken       int64 `json:"firstToken"`
	FirstText        int64 `json:"firstText"`
	End              int64 `json:"end"`
	FirstTokenMs     int64 `json:"firstTokenMs"`
	FirstTextMs      int64 `json:"firstTextMs"`
	DurationMs       int64 `json:"durationMs"`
}

// timingMatchWindow 是 timing.start 与消息 timestamp 的允许偏差。
// 二者在同一进程内取毫秒时间戳，正常只有几毫秒差；60s 只为兜底时钟/序列差异。
const timingMatchWindow = 60 * 1000

type piUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"` // pi 语义同 completion_tokens，已含 reasoning
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
// pi-plugin 写入的 timing custom entry 按文件顺序与用量记录关联，
// 填充首字/首Token/总用时；插件与解析器都跳过零 token 消息，保证顺序对齐。
func parsePiFile(path string) []UsageRecord {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var records []UsageRecord
	var timings []piTiming
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
		case "custom":
			// pi-plugin 的计时条目：先收集，随后按顺序分配给 assistant 用量记录
			if e.CustomType == "pi-tracker/timing" && len(e.Data) > 0 {
				var t piTiming
				if json.Unmarshal(e.Data, &t) == nil && t.DurationMs > 0 {
					timings = append(timings, t)
				}
			}
			continue
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
			OutputTokens:     max(0, u.Output-u.Reasoning), // output 含 thinking，落库为真实输出
			ReasoningTokens:  u.Reasoning,
			CacheReadTokens:  u.CacheRead,
			CacheWriteTokens: u.CacheWrite,
			CacheHitRate:     calcHitRate(u.Input, u.CacheRead),
			CreatedAt:        createdAt,
		}
		applyPiTiming(&rec, &timings)
		records = append(records, rec)
	}
	return records
}

// applyPiTiming 把下一条可用的计时条目挂到记录上。
// 插件随消息顺序写 timing，因此按序消费即可；用时间窗口兜底：
// 插件中途安装时，历史记录之前没有 timing，直接跳过，不会错配到后面的条目。
func applyPiTiming(rec *UsageRecord, timings *[]piTiming) {
	if len(*timings) == 0 {
		return
	}
	t := (*timings)[0]
	matched := abs64(t.Start-rec.CreatedAt) <= timingMatchWindow ||
		(t.MessageTimestamp > 0 && abs64(t.MessageTimestamp-rec.CreatedAt) <= timingMatchWindow)
	if !matched {
		return
	}
	*timings = (*timings)[1:]
	rec.FirstTokenMs = t.FirstTokenMs
	rec.FirstTextMs = t.FirstTextMs
	rec.DurationMs = t.DurationMs
	gen := rec.OutputTokens + rec.ReasoningTokens
	if rec.DurationMs > 0 && gen > 0 {
		rec.Speed = float64(gen) / float64(rec.DurationMs) * 1000
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
