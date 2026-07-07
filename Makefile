
.DEFAULT_GOAL = help
.ONESHELL: ; # Recipes execute in the same shell

API_DIR = apps/api
WEB_DIR = apps/web
SERVICE   ?= db

.PHONY: install
install: ## Install backend (uv) and frontend (pnpm) dependencies
	cd $(API_DIR) && uv sync --dev
	cd $(WEB_DIR) && pnpm install

.PHONY: up
up: ## Start a compose service — SERVICE=db|app|db-test (default db)
	cd $(API_DIR) && docker compose $(if $(filter db-test,$(SERVICE)),--profile test) up -d $(SERVICE)

.PHONY: down
down: ## Stop all compose services (including the test profile)
	cd $(API_DIR) && docker compose --profile test down

.PHONY: db
db: ## Start the local PostgreSQL container (backend)
	cd $(API_DIR) && docker compose up -d db

.PHONY: migrate
migrate: ## Apply the backend database migrations
	cd $(API_DIR) && uv run alembic upgrade head

.PHONY: api
api: ## Run the FastAPI backend on port 8000 — needs `make db` first
	cd $(API_DIR) && uv run python -m margen_api.main

.PHONY: web
web: ## Run the Vite frontend dev server on port 5173
	cd $(WEB_DIR) && pnpm dev

.PHONY: dev
dev: ## How to run the full stack (api + web run in their own terminals)
	@echo "Run the two apps in separate terminals:"
	@echo "  1) make db && make migrate && make api   # backend on :8000"
	@echo "  2) make web                              # frontend on :5173"

.PHONY: test
test: ## Run the backend (unit+e2e) and frontend test suites
	cd $(API_DIR) && make cover
	cd $(WEB_DIR) && pnpm test

.PHONY: lint
lint: ## Lint both apps
	cd $(API_DIR) && make lint
	cd $(WEB_DIR) && pnpm run lint

.PHONY: help
help: ## Show available targets
	@awk -F ':|##' '/^[^\t].+?:.*?##/ {\
	printf "\033[36m%-12s\033[0m %s\n", $$1, $$NF \
	}' $(MAKEFILE_LIST)
