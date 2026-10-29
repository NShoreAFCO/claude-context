// scripts/ctx-check.mjs
// One agent's OWN live context, read from its transcript. A sub-agent shares its parent's
// session id, so report.mjs would return the controller's number; this addresses the
// sub-agent's transcript instead (by agent id, or by a tag the parent put in its prompt).
// Facts only: no thresholds, no advice.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfigDir, resolveSessionId } from './lib/config-dir.mjs';
import { usedTokens } from './lib/token-math.mjs';

class CheckError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function parseArgs(argv) {
  const out = { sessionId: null, agentId: null, tag: null };
  const flags = { '--session-id': 'sessionId', '--agent-id': 'agentId', '--tag': 'tag' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const key = flags[name];
    if (!key) throw new CheckError('bad_args', `unknown argument: ${a}`);
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (typeof val !== 'string' || val === '')
      throw new CheckError('bad_args', `${name} needs a value`);
    out[key] = val;
  }
  if (out.agentId && out.tag)
    throw new CheckError('bad_args', 'use at most one of --agent-id, --tag');
  if (out.agentId && (!SAFE_ID.test(out.agentId) || out.agentId === '.' || out.agentId === '..'))
    throw new CheckError('bad_args', 'invalid --agent-id');
  return out;
}

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

function firstUserText(entries) {
  const e = entries.find((x) => x?.type === 'user');
  const c = e?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function readMeta(subDir, agentId) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(subDir, `agent-${agentId}.meta.json`), 'utf8'));
    return Number.isFinite(m?.spawnDepth) ? m.spawnDepth : null;
  } catch {
    return null;
  }
}

function findSession(configDir, sessionId) {
  const projects = path.join(configDir, 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of dirs) {
    const main = path.join(projects, d.name, `${sessionId}.jsonl`);
    const subDir = path.join(projects, d.name, sessionId, 'subagents');
    if (fs.existsSync(main) || fs.existsSync(subDir)) return { main, subDir };
  }
  return null;
}

export function ctxCheck({ sessionId, agentId = null, tag = null, configDir }) {
  if (!sessionId || !SAFE_ID.test(sessionId))
    throw new CheckError(
      'no_session',
      'no usable session id (use --session-id or CLAUDE_CODE_SESSION_ID)',
    );
  const found = findSession(configDir, sessionId);
  if (!found)
    throw new CheckError('no_session', `no transcript for session ${sessionId} under ${configDir}`);

  let transcript = found.main;
  let id = null;
  if (tag) {
    let files = [];
    try {
      files = fs.readdirSync(found.subDir).filter((f) => /^agent-.+\.jsonl$/.test(f));
    } catch {
      /* no subagents dir */
    }
    const hits = files.filter((f) =>
      firstUserText(readJsonl(path.join(found.subDir, f))).includes(tag),
    );
    const ids = hits.map((f) => f.slice('agent-'.length, -'.jsonl'.length));
    if (ids.length === 0)
      throw new CheckError(
        'not_found',
        `no sub-agent of ${sessionId} has the tag in its first message`,
      );
    if (ids.length > 1)
      throw new CheckError('ambiguous_tag', `tag matches ${ids.length} agents: ${ids.join(', ')}`);
    id = ids[0];
    transcript = path.join(found.subDir, hits[0]);
  } else if (agentId) {
    id = agentId;
    transcript = path.join(found.subDir, `agent-${agentId}.jsonl`);
  }
  if (!fs.existsSync(transcript))
    throw new CheckError('not_found', `no transcript at ${transcript}`);

  const entries = readJsonl(transcript);
  const ids = new Set();
  let usage = null;
  let anon = 0;
  for (const e of entries) {
    if (e?.type !== 'assistant') continue;
    const u = e?.message?.usage ?? e?.usage;
    if (!u || typeof u !== 'object') continue;
    ids.add(typeof e?.message?.id === 'string' ? e.message.id : `anon-${anon++}`);
    usage = u;
  }
  if (!usage) throw new CheckError('no_usage', `no assistant usage in ${transcript}`);

  const ctx = usedTokens(usage);
  return {
    context_tokens: ctx,
    context_k: Math.round(ctx / 1000),
    turns: ids.size,
    agent_id: id,
    spawn_depth: id ? readMeta(found.subDir, id) : null,
    transcript,
    source: 'transcript',
  };
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  try {
    const a = parseArgs(argv);
    const sessionId = a.sessionId ?? resolveSessionId({ env });
    const res = ctxCheck({
      sessionId,
      agentId: a.agentId,
      tag: a.tag,
      configDir: resolveConfigDir(env),
    });
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  } catch (err) {
    const code = err instanceof CheckError ? err.code : 'not_found';
    process.stdout.write(
      JSON.stringify({ error: code, detail: String(err?.message ?? err) }) + '\n',
    );
    return 2;
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) process.exitCode = runCli();
