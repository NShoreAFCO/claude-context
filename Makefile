# Makefile — DEV tooling for the claude-context repo. None of this ships with the plugin:
# the installed plugin is plugins/claude-context/ and imports only `node:` built-ins, while
# ESLint/Prettier live in the private root package.json. Run `npm install` once first.
# Every target self-documents with a `## ` comment; `make help` lists them.

.DEFAULT_GOAL := help
.PHONY: all test cover lint format help

all: lint format test ## Lint (autofix), format, then run the test suite

test: ## Run the full test suite (node --test)
	node --test tests/*.test.mjs

cover: ## One-shot coverage report (Node built-in)
	node --test --experimental-test-coverage tests/*.test.mjs

lint: ## Lint with ESLint (autofix)
	npx eslint . --fix

format: ## Format code with Prettier
	npx prettier --write .

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'
