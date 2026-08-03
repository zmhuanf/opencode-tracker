package db

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Pricing 单条定价，价格单位均为人民币/百万 token。
// PeakTimes 为每天重复的高峰时段，格式 "HH:mm-HH:mm"，start>end 表示跨午夜。
// PeakDates 为高峰全局启用日期区间，格式 "日期-日期"，任一端可为 *，空则高峰不计费。
type Pricing struct {
	Input          float64  `json:"input"`
	CacheRead      float64  `json:"cacheRead"`
	Output         float64  `json:"output"`
	Reasoning      float64  `json:"reasoning"`
	CacheWrite     float64  `json:"cacheWrite"`
	Multiplier     float64  `json:"multiplier"`
	PeakTimes      []string `json:"peakTimes"`
	PeakMultiplier float64  `json:"peakMultiplier"`
	PeakDates      []string `json:"peakDates"`
}

// PricingSaveReq 保存定价的请求，key 为 "提供商/模型"
type PricingSaveReq struct {
	Key     string  `json:"key"`
	Pricing Pricing `json:"pricing"`
}

const pricingFile = "pricing.json"

var (
	pMu       sync.RWMutex
	pCache    map[string]Pricing
	pLoaded   bool
)

func pricingPath() string {
	return filepath.Join(".", pricingFile)
}

// loadPricing 从磁盘加载，文件不存在时初始化空 map
func loadPricing() {
	pMu.Lock()
	defer pMu.Unlock()
	data, err := os.ReadFile(pricingPath())
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("read pricing.json failed", "error", err)
		}
		pCache = map[string]Pricing{}
		pLoaded = true
		return
	}
	var m map[string]Pricing
	if err := json.Unmarshal(data, &m); err != nil {
		slog.Warn("parse pricing.json failed", "error", err)
		pCache = map[string]Pricing{}
	} else {
		pCache = m
	}
	pLoaded = true
}

func ensurePricingLoaded() {
	pMu.RLock()
	loaded := pLoaded
	pMu.RUnlock()
	if !loaded {
		loadPricing()
	}
}

// GetPricing 返回 "提供商/模型" 对应的定价，不存在则返回零值和 false
func GetPricing(key string) (Pricing, bool) {
	ensurePricingLoaded()
	pMu.RLock()
	defer pMu.RUnlock()
	p, ok := pCache[key]
	return p, ok
}

// AllPricing 返回全量定价 map 的副本
func AllPricing() map[string]Pricing {
	ensurePricingLoaded()
	pMu.RLock()
	defer pMu.RUnlock()
	out := make(map[string]Pricing, len(pCache))
	for k, v := range pCache {
		out[k] = v
	}
	return out
}

// SavePricing 写入单条定价并持久化
func SavePricing(req PricingSaveReq) error {
	ensurePricingLoaded()
	pMu.Lock()
	defer pMu.Unlock()
	if pCache == nil {
		pCache = map[string]Pricing{}
	}
	pCache[req.Key] = req.Pricing
	data, err := json.MarshalIndent(pCache, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(pricingPath(), data, 0644)
}

// calcCost 按 token 用量、请求时间与定价算费用（人民币）
// 单价均为每百万 token，最终费用 = 各项 token/1e6*单价 之和 * 倍率，高峰时段再叠加高峰倍率
func calcCost(input, cacheRead, output, cacheWrite, reasoning, createdAt int64, p Pricing) float64 {
	const perMillion = 1_000_000
	raw := float64(input)/perMillion*p.Input +
		float64(cacheRead)/perMillion*p.CacheRead +
		float64(output)/perMillion*p.Output +
		float64(reasoning)/perMillion*p.Reasoning +
		float64(cacheWrite)/perMillion*p.CacheWrite
	raw *= p.Multiplier
	// 高峰计费需同时满足：倍率与时段已配置、启用日期区间非空、请求同时落在日期区间与时段内
	if p.PeakMultiplier > 0 && len(p.PeakTimes) > 0 && len(p.PeakDates) > 0 &&
		inPeakDates(createdAt, p.PeakDates) && inPeakTimes(createdAt, p.PeakTimes) {
		raw *= p.PeakMultiplier
	}
	return raw
}

// costOf 查定价并算费用，未定义返回 0
func costOf(provider, model string, input, cacheRead, output, cacheWrite, reasoning, createdAt int64) float64 {
	ensurePricingLoaded()
	pMu.RLock()
	p, ok := pCache[provider+"/"+model]
	pMu.RUnlock()
	if !ok {
		return 0
	}
	return calcCost(input, cacheRead, output, cacheWrite, reasoning, createdAt, p)
}

// inPeakTimes 判断请求时刻是否落在任一高峰时段内，时段每天重复，支持跨午夜
func inPeakTimes(ts int64, times []string) bool {
	t := time.UnixMilli(ts).In(time.Local)
	cur := t.Hour()*60 + t.Minute()
	for _, s := range times {
		start, end, ok := parsePeak(s)
		if !ok {
			continue
		}
		if start <= end {
			if cur >= start && cur <= end {
				return true
			}
		} else if cur >= start || cur <= end {
			// 跨午夜，如 22:00-02:00
			return true
		}
	}
	return false
}

// parsePeak 解析 "HH:mm-HH:mm" 为当天分钟数，start>end 表示跨午夜
func parsePeak(s string) (start, end int, ok bool) {
	parts := strings.SplitN(s, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	start, sOk := parseClock(parts[0])
	end, eOk := parseClock(parts[1])
	return start, end, sOk && eOk
}

// parseClock 解析 "HH:mm" 为当天分钟数
func parseClock(s string) (int, bool) {
	t, err := time.Parse("15:04", strings.TrimSpace(s))
	if err != nil {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

// inPeakDates 判断请求日期是否落在任一启用日期区间内，任一端可为 *（无限）
func inPeakDates(ts int64, dates []string) bool {
	t := time.UnixMilli(ts).In(time.Local)
	cur := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.Local)
	for _, s := range dates {
		start, end, ok := parseDateRange(s)
		if !ok {
			continue
		}
		if start != nil && cur.Before(*start) {
			continue
		}
		if end != nil && cur.After(*end) {
			continue
		}
		return true
	}
	return false
}

// parseDateRange 解析 "日期-日期"，两端可为 * 或省略，nil 表示无限
// 仅单个日期时视为精确当天（包含）
func parseDateRange(s string) (start, end *time.Time, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "*" || s == "*-*" {
		return nil, nil, true
	}
	parts := strings.SplitN(s, "-", 2)
	if strings.TrimSpace(parts[0]) != "*" {
		t, err := time.ParseInLocation("2006.1.2", strings.TrimSpace(parts[0]), time.Local)
		if err != nil {
			return nil, nil, false
		}
		start = &t
	}
	if len(parts) == 1 {
		// 仅起始日期，取精确当天
		return start, start, true
	}
	if strings.TrimSpace(parts[1]) != "*" {
		t, err := time.ParseInLocation("2006.1.2", strings.TrimSpace(parts[1]), time.Local)
		if err != nil {
			return nil, nil, false
		}
		end = &t
	}
	return start, end, true
}
