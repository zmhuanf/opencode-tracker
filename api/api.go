package api

import (
	"fmt"

	"github.com/zmhuanf/feng"
	"opencode-tracker/db"
)

// HandleUsage 返回分页记录 + 汇总。后端一次返回，前端不需要再算 summary。
func HandleUsage(_ feng.ServerContext, q *db.UsageQuery) (db.UsageResponse, error) {
	list, total := db.QueryUsage(*q)
	summary := db.QuerySummary(*q)
	page, size := q.Page, q.PageSize
	if page < 1 {
		page = 1
	}
	if size <= 0 || size > 500 {
		size = 50
	}
	return db.UsageResponse{
		List:     list,
		Summary:  summary,
		Total:    total,
		Page:     page,
		PageSize: size,
	}, nil
}

func HandleSummary(_ feng.ServerContext, q *db.UsageQuery) (db.Summary, error) {
	return db.QuerySummary(*q), nil
}

func HandleProviders(feng.ServerContext) ([]string, error) {
	return db.QueryProviders(), nil
}

func HandleModels(feng.ServerContext) ([]string, error) {
	return db.QueryModels(), nil
}

func HandleAgents(feng.ServerContext) ([]string, error) {
	return db.QueryAgents(), nil
}

// HandlePricing 返回全量定价 map
func HandlePricing(feng.ServerContext) (map[string]db.Pricing, error) {
	return db.AllPricing(), nil
}

// HandleSavePricing 保存单条定价，持久化到 pricing.json
func HandleSavePricing(_ feng.ServerContext, req *db.PricingSaveReq) (db.Pricing, error) {
	if req.Key == "" {
		return db.Pricing{}, fmt.Errorf("key is required")
	}
	if err := db.SavePricing(*req); err != nil {
		return db.Pricing{}, err
	}
	return req.Pricing, nil
}
