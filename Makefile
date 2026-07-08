# Makefile — DEV tooling for the claude-context repo. None of this ships with the plugin:
# the installed plugin is plugins/claude-context/ and imports only `node:` built-ins, while
# ESLint/Prettier live in the private root package.json. Run `npm install` once first.
# Every target self-documents with a `## ` comment; `make help` lists them.

.DEFAULT_GOAL := help
.PHONY: all test cover lint format loc help

# The code is the shipped plugin's scripts plus the test suite (all *.mjs);
# markdown, config, deps, and the vendored claude-hud/ are not counted.
SRC_DIR  := plugins/claude-context/scripts
TEST_DIR := tests

all: lint format test ## Lint (autofix), format, then run the test suite

test: ## Run the full test suite (node --test)
	node --test tests/*.test.mjs

cover: ## One-shot coverage report (Node built-in)
	node --test --experimental-test-coverage tests/*.test.mjs

lint: ## Lint with ESLint (autofix)
	npx eslint . --fix

format: ## Format code with Prettier
	npx prettier --write .

loc: ## Count lines of code (plugin source + tests, all *.mjs)
	@printf '  %-14s %5s lines\n' 'plugin source:' "$$(find $(SRC_DIR) -name '*.mjs' -exec cat {} + | wc -l | tr -d ' ')"
	@printf '  %-14s %5s lines\n' 'tests:'         "$$(find $(TEST_DIR) -name '*.mjs' -exec cat {} + | wc -l | tr -d ' ')"
	@printf '  %-14s %5s lines\n' 'total:'         "$$(find $(SRC_DIR) $(TEST_DIR) -name '*.mjs' -exec cat {} + | wc -l | tr -d ' ')"

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'
