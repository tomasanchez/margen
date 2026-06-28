
.DEFAULT_GOAL = help
.NOTPARALLEL: ; # Targets execute serially
.ONESHELL: ; # Recipes execute in the same shell

.PHONY: clean
clean: ## Removes all build and test artifacts
	rm -f .coverage
	rm -f *.db
	rm -rf .pytest_cache
	rm -rf .ruff_cache
	rm -rf dist
	rm -rf reports
	find . -type d -name __pycache__ -exec rm -rf {} +

.PHONY: dist-clean
dist-clean: clean ## Removes all build and test artifacts and virtual environment
	rm -rf .venv

.PHONY: install
install: ## Install runtime dependencies
	uv sync --no-dev

.PHONY: dev
dev: ## Install runtime and dev dependencies
	uv sync --dev

.PHONY: test
test: ## Executes the offline test tiers (unit + e2e)
	uv run pytest -m "not integration"

.PHONY: integration
integration: ## Runs the integration tier against the disposable test DB (docker compose --profile test up -d db-test)
	TEST_DATABASE_URL="$${TEST_DATABASE_URL:-postgresql+asyncpg://margen-api:margen-api@localhost:5433/margen-api-test}" uv run pytest -m integration

.PHONY: adr-check
adr-check: ## Validates the architecture decision registry
	uv run python scripts/prune_decisions.py check

.PHONY: adr-context
adr-context: ## Prints active architecture guidance for agents
	uv run python scripts/prune_decisions.py context

.PHONY: migrate
migrate: ## Applies relational database migrations
	uv run alembic upgrade head

ENV_FILE ?= .env
LOCAL_DATABASE_URL ?= postgresql+asyncpg://margen-api:margen-api@localhost:5432/margen-api

.PHONY: run
run: ## Migrates + starts the API against Supabase on port 8000 (loads $(ENV_FILE))
	uv run --env-file $(ENV_FILE) alembic upgrade head
	uv run --env-file $(ENV_FILE) python -m margen_api.main

# NOTE: run-local sets DATABASE_URL via a target-specific `export` (not a bash
# `VAR=value cmd` prefix) so the recipe is cross-platform — GNU make puts the var
# in the recipe's environment, working under both POSIX sh and Windows cmd.exe.
.PHONY: run-local
run-local: export DATABASE_URL := $(LOCAL_DATABASE_URL)
run-local: ## Migrates + starts the API against the local docker DB (Supabase auth still loaded from $(ENV_FILE))
	uv run --env-file $(ENV_FILE) alembic upgrade head
	uv run --env-file $(ENV_FILE) python -m margen_api.main

.PHONY: cover
cover: ## Executes the offline tiers (unit + e2e) with the coverage gate
	uv run pytest -m "not integration" --cov src/margen_api --cov-fail-under=100 --junitxml reports/xunit.xml \
	--cov-report xml:reports/coverage.xml --cov-report term-missing

.PHONY: format
format: ## Formats the code using Ruff
	uv run ruff format ./src ./tests ./scripts ./migrations

.PHONY: pre-commit
pre-commit: ## Runs pre-commit hooks on all files
	uv run pre-commit run --all-files

.PHONY: lint
lint: ## Applies static analysis and type checks
	uv run ruff check ./src ./tests ./scripts ./migrations
	uv run ruff format --check ./src ./tests ./scripts ./migrations
	uv run pyrefly check

.PHONY: fix
fix:  ## Fix lint errors
	uv run ruff check --fix ./src ./tests ./scripts ./migrations

.PHONY: help
help: ## Show make target documentation
	@awk -F ':|##' '/^[^\t].+?:.*?##/ {\
	printf "\033[36m%-30s\033[0m %s\n", $$1, $$NF \
	}' $(MAKEFILE_LIST)
