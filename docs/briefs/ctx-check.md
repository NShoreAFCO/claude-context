# Brief: `ctx-check` — a sub-agent's own context, from its transcript

## Why
A sub-agent shares its parent's session id, so `report.mjs` returns the *controller's*
context when a sub-agent runs it. Nested orchestration (proposal:
https://claude.ai/artifact/RiTUCJaxQQPPfR2EeDoiKH) needs each agent's own number.
Facts only, no thresholds or advice (repo CLAUDE.md rule).

## Facts (verified 2026-10-29)
- Main transcript: `<config-dir>/projects/<cwd-encoded>/<session-id>.jsonl`.
- Every sub-agent, at any depth (depth 2 verified), writes
  `<config-dir>/projects/<cwd-encoded>/<session-id>/subagents/agent-<agentId>.jsonl`
  plus `agent-<agentId>.meta.json` (`spawnDepth`, `description`, `model`, `finished`).
- Live context of a transcript = the last assistant message's
  `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
  Reuse `lib/transcript.mjs` / `lib/token-math.mjs` where they already do this.
- A sub-agent does not know its own agent id; it knows a unique tag its parent put in its
  prompt (e.g. `ORCH-TAG: wp-t02-orch1-7f2a`). That text appears in its transcript's first
  user message.

## Build
New entry point `plugins/claude-context/scripts/ctx-check.mjs` (dependency-free, same
style as `report.mjs`):
- `--session-id <id>` (default `CLAUDE_CODE_SESSION_ID`), and at most one of
  `--agent-id <id>` | `--tag <text>`. Neither → the main session transcript.
- Search `<config-dir>/projects/*/` for the session (cwd encoding is not needed).
- `--tag`: scan `subagents/*.jsonl` for the literal text; exactly one match required.
- Output: one JSON line, e.g.
  `{"context_tokens":132412,"context_k":132,"turns":41,"agent_id":"a4bc…","spawn_depth":2,"transcript":"…","source":"transcript"}`
  `turns` = number of distinct assistant API messages (dedupe by `message.id`).
  `spawn_depth` from the meta file when present, else null.
- Errors → JSON `{"error":"<code>","detail":"…"}` on stdout, exit 2: `no_session`,
  `not_found`, `ambiguous_tag` (list the matching agent ids), `bad_args`, `no_usage`.
- Read the transcript line by line tolerantly (skip bad JSON lines, as transcript.mjs does).

Also: a section "Sub-agents: ctx-check" in `plugins/claude-context/skills/claude-context/SKILL.md`
(how to call it with `${CLAUDE_PLUGIN_ROOT}`, what the fields mean, facts only);
CHANGELOG entry; version 0.3.4 in every manifest the existing release tests check.

## Tests (TDD, `node --test`)
Fixtures under `tests/fixtures/ctx-check/` with a fake config dir: main transcript, two
sub-agent transcripts (one depth 2), meta files, one bad JSON line. Cover: main, agent-id,
tag unique, tag ambiguous, tag not found, no usage, turns dedupe, bad args.
All existing tests stay green; eslint clean.

## Boundaries
- Repo `C:\Users\chrom\Documents\Devel\claude-context` only, branch `feature/ctx-check`
  from `main`. Don't touch `Devel/cc-upstream` or anything upstream (Ovid).
- `core.autocrlf=input` is set; keep LF endings.
- No `make` on this host: run the Makefile targets' commands directly.
- PR to the fork (`origin`, NShoreAFCO/claude-context) `main`; do NOT merge.
- Report to `docs/reports/ctx-check-impl.md`; reply ≤ 15 lines. Stop at 60 turns or
  ~150k context with a handoff in the report.
