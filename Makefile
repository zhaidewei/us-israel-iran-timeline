SHELL := /bin/zsh

.PHONY: help dev refresh-local refresh-kv

help:
	@echo "Targets:"
	@echo "  make dev             # 启动本地开发服务"
	@echo "  make refresh-local   # 刷新新闻+AI解读（消耗 token，写入本地 JSON）"
	@echo "  make refresh-kv      # 刷新新闻+AI解读（消耗 token，写入远端 KV）"

dev:
	node server.js

refresh-local:
	set -a; source .env.vercel; set +a; \
	node scripts/token-refresh.js --target=local

refresh-kv:
	set -a; source .env.vercel; set +a; \
	node scripts/token-refresh.js --target=kv
