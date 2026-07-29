package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/zmhuanf/feng"
	"opencode-tracker/api"
	"opencode-tracker/db"
)

func main() {
	cfg := feng.NewDefaultServerConfig()
	cfg.Addr, cfg.Port = "0.0.0.0", 8080

	server := feng.NewServer(cfg)

	// 业务路由走 feng 的 WebSocket 通道。
	if err := server.Handle("/api/usage", api.HandleUsage); err != nil {
		slog.Error("register /api/usage failed", "error", err)
		os.Exit(1)
	}
	if err := server.Handle("/api/usage/summary", api.HandleSummary); err != nil {
		slog.Error("register /api/usage/summary failed", "error", err)
		os.Exit(1)
	}
	if err := server.Handle("/api/providers", api.HandleProviders); err != nil {
		slog.Error("register /api/providers failed", "error", err)
		os.Exit(1)
	}
	if err := server.Handle("/api/models", api.HandleModels); err != nil {
		slog.Error("register /api/models failed", "error", err)
		os.Exit(1)
	}

	// gin 仅用于托管前端构建产物。必须挂子路径，否则 /*filepath 会吞掉 feng 的 /game 和 /system。
	engine := server.Gin()
	engine.StaticFS("/web", http.Dir("web/dist"))
	engine.GET("/", func(c *gin.Context) {
		c.Redirect(http.StatusMovedPermanently, "/web/")
	})

	syncCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db.StartSync(syncCtx)

	if err := server.ListenAndServe(context.Background()); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
