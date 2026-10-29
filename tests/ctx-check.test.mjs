// tests/ctx-check.test.mjs
// Fixtures under tests/fixtures/ctx-check/ are redacted cuts of REAL transcripts (usage
// fields and structure kept, text redacted); see CLAUDE.md "golden fixtures".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'plugins/claude-context/scripts/ctx-check.mjs');
const configDir = path.join(root, 'tests/fixtures/ctx-check/config');

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir, ...env },
  });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one JSON line');
  return { status: r.status, out: JSON.parse(lines[0]) };
}

test('main transcript when neither --agent-id nor --tag', () => {
  const { status, out } = run(['--session-id', 'sess-0001']);
  assert.equal(status, 0);
  assert.equal(out.context_tokens, 89511);
  assert.equal(out.context_k, 89);
  assert.equal(out.turns, 5);
  assert.equal(out.agent_id, null);
  assert.equal(out.spawn_depth, null);
  assert.equal(out.source, 'transcript');
  assert.ok(out.transcript.endsWith('sess-0001.jsonl'));
});

test('session id defaults to CLAUDE_CODE_SESSION_ID', () => {
  const { status, out } = run([], { CLAUDE_CODE_SESSION_ID: 'sess-0001' });
  assert.equal(status, 0);
  assert.equal(out.context_tokens, 89511);
});

test('--agent-id reads that sub-agent, with depth from meta', () => {
  const { status, out } = run(['--session-id', 'sess-0001', '--agent-id', 'aaaa1111']);
  assert.equal(status, 0);
  assert.equal(out.context_tokens, 45546);
  assert.equal(out.turns, 6);
  assert.equal(out.agent_id, 'aaaa1111');
  assert.equal(out.spawn_depth, 1);
});

test('depth-2 agent reports spawn_depth 2', () => {
  const { out } = run(['--session-id', 'sess-0001', '--agent-id', 'bbbb2222']);
  assert.equal(out.context_tokens, 38524);
  assert.equal(out.turns, 1);
  assert.equal(out.spawn_depth, 2);
});

test('--tag with exactly one match resolves the agent', () => {
  const { status, out } = run(['--session-id', 'sess-0001', '--tag', 'orch-alpha-1']);
  assert.equal(status, 0);
  assert.equal(out.agent_id, 'aaaa1111');
  assert.equal(out.context_tokens, 45546);
});

test('--tag matching several agents is ambiguous and lists them', () => {
  const { status, out } = run(['--session-id', 'sess-0001', '--tag', 'orch-beta']);
  assert.equal(status, 2);
  assert.equal(out.error, 'ambiguous_tag');
  assert.match(out.detail, /bbbb2222/);
  assert.match(out.detail, /cccc3333/);
});

test('--tag matching nothing is not_found', () => {
  const { status, out } = run(['--session-id', 'sess-0001', '--tag', 'no-such-tag']);
  assert.equal(status, 2);
  assert.equal(out.error, 'not_found');
});

test('unknown agent id is not_found', () => {
  const { status, out } = run(['--session-id', 'sess-0001', '--agent-id', 'zzzz']);
  assert.equal(status, 2);
  assert.equal(out.error, 'not_found');
});

test('unknown session is no_session; missing session id too', () => {
  const a = run(['--session-id', 'nope']);
  assert.equal(a.status, 2);
  assert.equal(a.out.error, 'no_session');
  const b = run([]);
  assert.equal(b.status, 2);
  assert.equal(b.out.error, 'no_session');
});

test('transcript without assistant usage is no_usage', () => {
  const { status, out } = run(['--session-id', 'sess-0001', '--agent-id', 'cccc3333']);
  assert.equal(status, 2);
  assert.equal(out.error, 'no_usage');
});

test('--agent-id and --tag together is bad_args; so is a path-like agent id', () => {
  const a = run(['--session-id', 'sess-0001', '--agent-id', 'aaaa1111', '--tag', 'x']);
  assert.equal(a.status, 2);
  assert.equal(a.out.error, 'bad_args');
  const b = run(['--session-id', 'sess-0001', '--agent-id', '../x']);
  assert.equal(b.out.error, 'bad_args');
  const c = run(['--session-id', 'sess-0001', '--bogus']);
  assert.equal(c.out.error, 'bad_args');
});

test('turns dedupes assistant lines sharing a message id, and bad JSON lines are skipped', () => {
  // main fixture has more assistant lines than distinct message ids, plus one bad line
  const raw = spawnSync('node', ['-e', `
    const l=require('fs').readFileSync(${JSON.stringify(path.join(configDir, 'projects/proj-a/sess-0001.jsonl'))},'utf8').split('\n');
    let a=0;for(const s of l){try{if(JSON.parse(s).type==='assistant')a++}catch{}}console.log(a)`], { encoding: 'utf8' });
  assert.ok(Number(raw.stdout) > 5, 'fixture has duplicate-id assistant lines');
  assert.ok(raw.stdout.length > 0);
  assert.equal(run(['--session-id', 'sess-0001']).out.turns, 5);
});

test('output contains no advice or thresholds (facts only)', () => {
  const { out } = run(['--session-id', 'sess-0001']);
  assert.deepEqual(Object.keys(out).sort(), [
    'agent_id', 'context_k', 'context_tokens', 'source', 'spawn_depth', 'transcript', 'turns',
  ]);
});
