package db

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

// Pricing 单条定价，价格单位均为人民币/百万 token
type Pricing struct {
	Input      float64 `json:"input"`
	CacheRead  float64 `json:"cacheRead"`
	Output     float64 `json:"output"`
	Reasoning  float64 `json:"reasoning"`
	CacheWrite float64 `json:"cacheWrite"`
	Multiplier float64 `json:"multiplier"`
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

// calcCost 按 token 用量和定价算费用（人民币）
// 单价均为每百万 token，最终费用 = 各项 token/1e6*单价 之和 再乘倍率
func calcCost(input, cacheRead, output, cacheWrite, reasoning int64, p Pricing) float64 {
	const perMillion = 1_000_000
	raw := float64(input)/perMillion*p.Input +
		float64(cacheRead)/perMillion*p.CacheRead +
		float64(output)/perMillion*p.Output +
		float64(reasoning)/perMillion*p.Reasoning +
		float64(cacheWrite)/perMillion*p.CacheWrite
	return raw * p.Multiplier
}

// costOf 查定价并算费用，未定义返回 0
func costOf(provider, model string, input, cacheRead, output, cacheWrite, reasoning int64) float64 {
	ensurePricingLoaded()
	pMu.RLock()
	p, ok := pCache[provider+"/"+model]
	pMu.RUnlock()
	if !ok {
		return 0
	}
	return calcCost(input, cacheRead, output, cacheWrite, reasoning, p)
}
