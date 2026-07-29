package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const (
	syncInterval  = 30 * time.Second
	mutableWindow = 24 * time.Hour
)

var dbPath = func() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".opencode", "opencode.db")
}()

// openReadOnly 打开 opencode.db 为只读 + WAL 共享模式，不影响 opencode 自身的写锁。
func openReadOnly() (*sql.DB, error) {
	if dbPath == "" {
		return nil, fmt.Errorf("cannot determine opencode db path")
	}
	if _, err := os.Stat(dbPath); err != nil {
		return nil, err
	}
	dsn := fmt.Sprintf("file:%s?mode=ro&_journal_mode=wal&_query_only=true", dbPath)
	conn, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	return conn, nil
}

// hasTimeUpdated 检查 message 表是否存在 time_updated 列，opencode 旧版可能没有。
func hasTimeUpdated(conn *sql.DB) (bool, error) {
	rows, err := conn.Query("PRAGMA table_info(message)")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, dflt, pk any
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == "time_updated" {
			return true, nil
		}
	}
	return false, nil
}
