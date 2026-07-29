package api

import (
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
