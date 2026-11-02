# ResQ AI - developer convenience targets.
#
#   make help          list every target
#   make install       backend virtualenv + frontend node_modules
#   make env           create .env files from the examples
#   make dev           run backend (:8000) and frontend (:3000) dev servers
#   make check         every CI quality gate (lint, typecheck, tests, build)
#   make up            build and start the Docker stack
#
# Backend commands use backend/.venv when it exists (created by `make install`), otherwise
# the `python3` on PATH. Override with e.g. `make test PYTHON=/path/to/python`.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BACKEND := $(ROOT)/backend
FRONTEND := $(ROOT)/frontend

VENV ?= $(BACKEND)/.venv
PYTHON_BOOTSTRAP ?= python3
PYTHON ?= $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,python3)
NPM ?= npm
COMPOSE ?= docker compose

BACKEND_HOST ?= 127.0.0.1
BACKEND_PORT ?= 8000

.PHONY: help install backend-install frontend-install env secrets vapid \
	dev dev-backend dev-frontend \
	lint backend-lint frontend-lint format typecheck \
	test backend-test frontend-test build check \
	docker-build up down logs ps clean

## ------------------------------------------------------------------------------------------
## Help
## ------------------------------------------------------------------------------------------

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\nTargets:\n"} \
	  /^[a-zA-Z0-9_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ------------------------------------------------------------------------------------------
## Setup
## ------------------------------------------------------------------------------------------

install: backend-install frontend-install ## Install backend (virtualenv) and frontend dependencies

backend-install: ## Create backend/.venv and install the pinned dev requirements
	@if [ ! -x "$(VENV)/bin/python" ]; then $(PYTHON_BOOTSTRAP) -m venv "$(VENV)"; fi
	"$(VENV)/bin/python" -m pip install --upgrade pip
	"$(VENV)/bin/python" -m pip install -r "$(BACKEND)/requirements-dev.txt"

frontend-install: ## Install frontend dependencies exactly as locked (npm ci)
	cd "$(FRONTEND)" && $(NPM) ci --no-audit --no-fund

env: ## Create .env, backend/.env and frontend/.env.local from the examples (never overwrites)
	@for pair in ".env.example:.env" "backend/.env.example:backend/.env" \
	    "frontend/.env.example:frontend/.env.local"; do \
	  src="$(ROOT)/$${pair%%:*}"; dst="$(ROOT)/$${pair##*:}"; \
	  if [ -e "$$dst" ]; then echo "kept    $${pair##*:} (already exists)"; \
	  else cp "$$src" "$$dst"; echo "created $${pair##*:}"; fi; \
	done
	@echo "Next: fill in NEXTAUTH_SECRET, BACKEND_JWT_SECRET and INTERNAL_API_KEY (make secrets)."

secrets: ## Print fresh random values for the three shared secrets
	@$(PYTHON) -c 'import secrets; [print(f"{name}={secrets.token_urlsafe(48)}") for name in ("NEXTAUTH_SECRET", "BACKEND_JWT_SECRET", "INTERNAL_API_KEY")]'

vapid: ## Print a new VAPID key pair for web push (needs the backend dependencies)
	@$(PYTHON) -c 'import base64; from cryptography.hazmat.primitives import serialization as s; from cryptography.hazmat.primitives.asymmetric import ec; key = ec.generate_private_key(ec.SECP256R1()); b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode(); print("VAPID_PUBLIC_KEY=" + b64(key.public_key().public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint))); print("VAPID_PRIVATE_KEY=" + b64(key.private_numbers().private_value.to_bytes(32, "big")))'

## ------------------------------------------------------------------------------------------
## Development servers
## ------------------------------------------------------------------------------------------

dev: ## Run backend and frontend dev servers together (Ctrl+C stops both)
	@$(MAKE) --no-print-directory -j2 dev-backend dev-frontend

dev-backend: ## Run the FastAPI backend with auto-reload on http://127.0.0.1:8000
	cd "$(BACKEND)" && $(PYTHON) -m uvicorn app.main:app --reload \
	  --host $(BACKEND_HOST) --port $(BACKEND_PORT)

dev-frontend: ## Run the Next.js dev server on http://localhost:3000
	cd "$(FRONTEND)" && $(NPM) run dev

## ------------------------------------------------------------------------------------------
## Quality gates (the same commands CI runs)
## ------------------------------------------------------------------------------------------

lint: backend-lint frontend-lint ## Lint backend (ruff) and frontend (eslint)

backend-lint: ## ruff check + ruff format --check
	cd "$(BACKEND)" && $(PYTHON) -m ruff check . && $(PYTHON) -m ruff format --check .

frontend-lint: ## eslint
	cd "$(FRONTEND)" && $(NPM) run lint

format: ## Auto-format the backend and apply safe ruff fixes
	cd "$(BACKEND)" && $(PYTHON) -m ruff format . && $(PYTHON) -m ruff check --fix .

typecheck: ## TypeScript type check (tsc --noEmit)
	cd "$(FRONTEND)" && $(NPM) run typecheck

test: backend-test frontend-test ## Run every test suite

backend-test: ## pytest (no network access needed)
	cd "$(BACKEND)" && $(PYTHON) -m pytest -q

frontend-test: ## vitest
	cd "$(FRONTEND)" && $(NPM) test

build: ## Production build of the frontend (next build)
	cd "$(FRONTEND)" && \
	  NEXTAUTH_SECRET="$${NEXTAUTH_SECRET:-local-build-placeholder}" \
	  BACKEND_JWT_SECRET="$${BACKEND_JWT_SECRET:-local-build-placeholder}" \
	  $(NPM) run build

check: lint typecheck test build ## Every CI gate: lint, typecheck, tests and the production build

## ------------------------------------------------------------------------------------------
## Docker
## ------------------------------------------------------------------------------------------

docker-build: ## Build both Docker images
	cd "$(ROOT)" && $(COMPOSE) build

up: ## Build and start the stack in the background (needs .env)
	cd "$(ROOT)" && $(COMPOSE) up --build --detach --wait
	@echo "Web app: http://localhost:3000   API docs: http://localhost:8000/docs"

down: ## Stop the stack (data volume is kept)
	cd "$(ROOT)" && $(COMPOSE) down

logs: ## Follow the logs of both services
	cd "$(ROOT)" && $(COMPOSE) logs --follow --tail=200

ps: ## Show container status and health
	cd "$(ROOT)" && $(COMPOSE) ps

## ------------------------------------------------------------------------------------------
## Housekeeping
## ------------------------------------------------------------------------------------------

clean: ## Remove caches and build output (keeps node_modules, .venv and the database)
	find "$(BACKEND)" -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf "$(BACKEND)/.pytest_cache" "$(BACKEND)/.ruff_cache" "$(ROOT)/.ruff_cache"
	rm -rf "$(FRONTEND)/.next" "$(FRONTEND)/coverage" "$(FRONTEND)/tsconfig.tsbuildinfo"
