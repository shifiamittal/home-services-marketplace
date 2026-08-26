import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = path.join(projectRoot, 'scripts', 'cloudflare-production.sh');
const sitesEnvSource = path.join(projectRoot, 'scripts', 'sites-env.sh');

function bashPath() {
  return process.env.BASH_PATH ?? 'bash';
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nivasa-cloudflare-script-'));
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(scriptSource, path.join(scripts, 'cloudflare-production.sh'));
  copyFileSync(sitesEnvSource, path.join(scripts, 'sites-env.sh'));
  chmodSync(path.join(scripts, 'cloudflare-production.sh'), 0o644);
  chmodSync(path.join(scripts, 'sites-env.sh'), 0o644);
  return root;
}

function run(root, args, env = {}) {
  return spawnSync(bashPath(), [path.join(root, 'scripts', 'cloudflare-production.sh'), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('non-executable production script reaches the guarded Wrangler action through Bash', () => {
  const root = fixture();
  try {
    const bin = path.join(root, 'node_modules', '.bin');
    const invocationLog = path.join(root, 'wrangler-arguments.txt');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'wrangler'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$WRANGLER_ARGUMENT_LOG"\n');
    writeFileSync(path.join(bin, 'tsc'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(path.join(bin, 'wrangler'), 0o755);
    chmodSync(path.join(bin, 'tsc'), 0o755);

    const result = run(root, ['migrations-apply'], { WRANGLER_ARGUMENT_LOG: 'wrangler-arguments.txt' });
    assert.equal(result.status, 0, result.stderr);
    const invocation = readFileSync(invocationLog, 'utf8').trimEnd().split('\n');
    assert.deepEqual(invocation.slice(0, 5), [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--config',
    ]);
    assert.match(invocation[5], /\/nivasa-cloudflare-script-[^/]+\/wrangler\.jsonc$/);
    assert.equal(invocation[6], '--remote');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('environment re-entry preserves every argument exactly', () => {
  const root = fixture();
  try {
    const script = path.join(root, 'scripts', 'cloudflare-production.sh');
    const source = readFileSync(script, 'utf8');
    const guardEnd = source.indexOf('\naction="${1:-}"');
    assert.notEqual(guardEnd, -1);
    writeFileSync(script, `${source.slice(0, guardEnd)}\nprintf '%s\\0' "$@" > "$ARGUMENT_LOG"\n`);
    chmodSync(script, 0o644);

    const args = ['migrations-apply', 'two words', 'semi;colon', '$HOME', 'quote"mark', 'back\\slash', ''];
    const argumentLog = path.join(root, 'arguments.bin');
    const result = run(root, args, { ARGUMENT_LOG: 'arguments.bin' });
    assert.equal(result.status, 0, result.stderr);
    const recorded = readFileSync(argumentLog).toString('utf8').split('\0');
    recorded.pop();
    assert.deepEqual(recorded, args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
