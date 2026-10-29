# ctx-check implementation report

Branch `feature/ctx-check`, PR to `origin` main (not merged). Version 0.3.4.

## What was built
- `plugins/claude-context/scripts/ctx-check.mjs` (dependency-free; exports `parseArgs`, `ctxCheck`, `runCli`).
- Skill section "Sub-agents: ctx-check", CHANGELOG 0.3.4, version 0.3.4 in plugin.json, marketplace.json, package.json (the three the manifest test checks).
- Tests: `tests/ctx-check.test.mjs` (13) plus 1 skill test. Full suite 203/203, eslint and prettier clean.
- Fixtures `tests/fixtures/ctx-check/config/`: redacted cuts of real transcripts from this session (main, depth-1 agent a4bc..., depth-2 agent a1fa...). All string leaves redacted except structural keys; usage fields and message ids kept; ids/session renamed; the tag text injected into the first user message; one bad JSON line appended to main; `cccc3333` is the first line only (no usage).

## Deviations / decisions
- `context_k` is `Math.round(tokens/1000)` (89511 -> 90).
- `--tag` matches the literal text in the first user message only (not the whole file), so an agent that merely quotes a tag later is not matched.
- Agent ids must match `[A-Za-z0-9._-]+` (path-traversal guard) -> `bad_args` otherwise.
- Unexpected I/O failures map to `not_found`. package-lock.json (0.2.0) was already stale and left alone.
- The brief file `docs/briefs/` is untracked in the repo and was not committed.

## Live runs (session cbf92d3e-3aa0-4f76-a2df-f740decf0a53)
Main:
`{"context_tokens":151979,"context_k":152,"turns":33,"agent_id":null,"spawn_depth":null,...,"source":"transcript"}`

Depth 1, `--agent-id a4bc3d1540897d21f`:
`{"context_tokens":45546,"context_k":46,"turns":6,"agent_id":"a4bc3d1540897d21f","spawn_depth":1,...}`

Depth 2, `--agent-id a1fabba3b6e7bdb97`:
`{"context_tokens":38524,"context_k":39,"turns":1,"agent_id":"a1fabba3b6e7bdb97","spawn_depth":2,...}`

Unknown tag: `{"error":"not_found","detail":"no sub-agent of cbf92d3e-... has the tag in its first message"}` (exit 2).
