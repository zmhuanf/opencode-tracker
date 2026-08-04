package db

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type store struct {
	mu         sync.RWMutex
	rows       []UsageRecord
	maxUpdated int64
	piFiles    map[string]piFileStamp
}

// 内存缓存：全量副本 + 增量同步。
// 启动时全量拉一次，每 30s 用 time_updated 增量补数据。
var s = &store{}

func StartSync(ctx context.Context) {
	if err := fullLoad(); err != nil {
		slog.Warn("opencode db initial load failed", "path", resolveDBPath(), "error", err)
		s.mu.Lock()
		s.rows = nil
		s.maxUpdated = 0
		s.mu.Unlock()
	}
	syncPi()
	slog.Info("usage db loaded", "records", Size(), "agents", QueryAgents())
	go loop(ctx)
}

func Size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.rows)
}

func loop(ctx context.Context) {
	t := time.NewTicker(syncInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = incrementalSync()
			syncPi()
		}
	}
}

func fullLoad() error {
	conn, err := openReadOnly()
	if err != nil {
		return err
	}
	defer conn.Close()

	useUpdated, err := hasTimeUpdated(conn)
	if err != nil {
		return err
	}
	rows, err := fetchSince(conn, 0, useUpdated)
	if err != nil {
		return err
	}

	records := make([]UsageRecord, 0, len(rows))
	var maxUpdated int64
	for _, r := range rows {
		rec, ok := parseMessage(r)
		if !ok {
			continue
		}
		records = append(records, rec)
		if r.TimeUpdated > maxUpdated {
			maxUpdated = r.TimeUpdated
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].CreatedAt > records[j].CreatedAt })

	s.mu.Lock()
	s.rows = records
	s.maxUpdated = maxUpdated
	s.mu.Unlock()
	return nil
}

func incrementalSync() error {
	conn, err := openReadOnly()
	if err != nil {
		return err
	}
	defer conn.Close()

	useUpdated, err := hasTimeUpdated(conn)
	if err != nil {
		return err
	}
	if !useUpdated {
		// 旧版 opencode 没有 time_updated 字段，全量重建。
		return fullLoad()
	}

	s.mu.RLock()
	since := s.maxUpdated
	s.mu.RUnlock()
	// 倒退 mutableWindow 覆盖 opencode 近 24h 的可写窗口，避免漏掉边界更新。
	since -= mutableWindow.Milliseconds()
	if since < 0 {
		since = 0
	}

	rows, err := fetchSince(conn, since, true)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	index := make(map[string]int, len(s.rows))
	for i, r := range s.rows {
		index[agentKey(r.Agent, r.CreatedAt)] = i
	}
	var newMax int64
	for _, r := range rows {
		rec, ok := parseMessage(r)
		if !ok {
			continue
		}
		if i, exists := index[agentKey(rec.Agent, rec.CreatedAt)]; exists {
			s.rows[i] = rec
		} else {
			s.rows = append(s.rows, rec)
			index[agentKey(rec.Agent, rec.CreatedAt)] = len(s.rows) - 1
		}
		if r.TimeUpdated > newMax {
			newMax = r.TimeUpdated
		}
	}
	sort.Slice(s.rows, func(i, j int) bool { return s.rows[i].CreatedAt > s.rows[j].CreatedAt })
	if newMax > s.maxUpdated {
		s.maxUpdated = newMax
	}
	return nil
}

// agentKey 生成存储内行的唯一 key：(agent, createdAt)。
// opencode 与 pi 的 createdAt 独立自增，可能撞值，必须带上 agent 区分。
func agentKey(agent string, createdAt int64) string {
	return agent + ":" + strconv.FormatInt(createdAt, 10)
}

// syncPi 增量同步 pi 会话目录：
// 用 (size, mtime) 指纹对比上次扫描，只有文件新增/变更/删除时才重新解析。
// pi 文件量小，变更时直接全量重建 agent=pi 的子集。
func syncPi() {
	dir := piSessionDir()
	if dir == "" {
		return
	}
	type piFileEntry struct {
		path  string
		stamp piFileStamp
	}
	var files []piFileEntry
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		files = append(files, piFileEntry{path, piFileStamp{size: info.Size(), mtime: info.ModTime().UnixMilli()}})
		return nil
	})

	s.mu.RLock()
	changed := len(files) != len(s.piFiles)
	seen := make(map[string]bool, len(files))
	if !changed {
		for _, f := range files {
			seen[f.path] = true
			if st, ok := s.piFiles[f.path]; !ok || st != f.stamp {
				changed = true
				break
			}
		}
	}
	s.mu.RUnlock()
	if !changed {
		return
	}

	records := loadPiRecords()

	s.mu.Lock()
	kept := s.rows[:0:0]
	for _, r := range s.rows {
		if r.Agent != "pi" {
			kept = append(kept, r)
		}
	}
	s.rows = append(kept, records...)
	sort.Slice(s.rows, func(i, j int) bool { return s.rows[i].CreatedAt > s.rows[j].CreatedAt })
	s.piFiles = make(map[string]piFileStamp, len(files))
	for _, f := range files {
		s.piFiles[f.path] = f.stamp
	}
	s.mu.Unlock()
}

// QueryUsage 按 q 过滤、排序、分页后返回记录切片与总数。
func QueryUsage(q UsageQuery) ([]UsageRecord, int64) {
	page, size := normalizePaging(q.Page, q.PageSize)

	s.mu.RLock()
	defer s.mu.RUnlock()

	filtered := s.rows[:0:0]
	for _, r := range s.rows {
		if q.Start > 0 && r.CreatedAt < q.Start {
			continue
		}
		if q.End > 0 && r.CreatedAt > q.End {
			continue
		}
		if q.Agent != "" && r.Agent != q.Agent {
			continue
		}
		if q.Provider != "" && r.Provider != q.Provider {
			continue
		}
		if q.Model != "" && r.Model != q.Model {
			continue
		}
		filtered = append(filtered, r)
	}
	total := int64(len(filtered))

	start := int64(page-1) * int64(size)
	if start < 0 || start >= total {
		return []UsageRecord{}, total
	}
	end := start + int64(size)
	if end > total {
		end = total
	}
	pageRows := filtered[start:end]
	out := make([]UsageRecord, len(pageRows))
	for i, r := range pageRows {
		r.Cost = costOf(r.Provider, r.Model, r.InputTokens, r.CacheReadTokens, r.OutputTokens, r.CacheWriteTokens, r.ReasoningTokens, r.CreatedAt)
		out[i] = r
	}
	return out, total
}

func QuerySummary(q UsageQuery) Summary {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var sum Summary
	var input, cacheRead int64
	for _, r := range s.rows {
		if q.Start > 0 && r.CreatedAt < q.Start {
			continue
		}
		if q.End > 0 && r.CreatedAt > q.End {
			continue
		}
		if q.Agent != "" && r.Agent != q.Agent {
			continue
		}
		if q.Provider != "" && r.Provider != q.Provider {
			continue
		}
		if q.Model != "" && r.Model != q.Model {
			continue
		}
		sum.Total++
		sum.InputTokens += r.InputTokens
		sum.OutputTokens += r.OutputTokens
		sum.Reasoning += r.ReasoningTokens
		sum.CacheRead += r.CacheReadTokens
		sum.CacheWrite += r.CacheWriteTokens
		sum.Cost += costOf(r.Provider, r.Model, r.InputTokens, r.CacheReadTokens, r.OutputTokens, r.CacheWriteTokens, r.ReasoningTokens, r.CreatedAt)
		input += r.InputTokens
		cacheRead += r.CacheReadTokens
	}
	sum.CacheHitRate = calcHitRate(input, cacheRead)
	return sum
}

func QueryProviders() []string {
	return uniqueValues(func(r UsageRecord) string { return r.Provider })
}

func QueryModels() []string {
	return uniqueValues(func(r UsageRecord) string { return r.Model })
}

func QueryAgents() []string {
	return uniqueValues(func(r UsageRecord) string { return r.Agent })
}

func uniqueValues(f func(UsageRecord) string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := make(map[string]struct{})
	for _, r := range s.rows {
		v := f(r)
		if v == "" {
			continue
		}
		seen[v] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func normalizePaging(page, size int) (int, int) {
	if page < 1 {
		page = 1
	}
	if size <= 0 || size > 500 {
		size = 50
	}
	return page, size
}
