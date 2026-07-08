// tests/manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

test('plugin.json has required fields', () => {
  const m = readJson('plugins/claude-context/.claude-plugin/plugin.json');
  assert.equal(m.name, 'claude-context');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.commands.includes('./commands/setup.md'));
  assert.equal(m.skills, undefined, 'no skills field so root SKILL.md auto-loads');
});

test('marketplace.json points at this plugin', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'claude-context');
  assert.equal(m.plugins[0].name, 'claude-context');
  assert.equal(m.plugins[0].source, './plugins/claude-context');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);   // top-level (canonical) — NOT metadata.version
  assert.equal(typeof m.description, 'string'); // top-level (canonical) — NOT metadata.description
});

test('the three version fields agree (root package.json is private but must not drift)', () => {
  const pkg = readJson('package.json').version;
  const plugin = readJson('plugins/claude-context/.claude-plugin/plugin.json').version;
  const marketplace = readJson('.claude-plugin/marketplace.json').version;
  assert.equal(plugin, marketplace, 'plugin.json and marketplace.json versions must match');
  assert.equal(pkg, plugin, 'root package.json version must match the shipped plugin version');
});
