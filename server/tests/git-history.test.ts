import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitService } from '../src/services/gitService.js';
import { workspaceService } from '../src/services/workspaceService.js';

test('history lists commit author and provides a single-file diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'together-history-'));
  const original = workspaceService.getRoot;
  workspaceService.getRoot = () => root;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Akshit');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'one.txt'), 'first\n');
    git('add', '.');
    git('commit', '-m', 'first');
    await writeFile(join(root, 'one.txt'), 'second\n');
    await writeFile(join(root, 'two.txt'), 'other\n');
    git('add', '.');
    git('commit', '-m', 'Update files');
    const history = await gitService.history('workspace');
    assert.equal(history[0].author, 'Akshit');
    assert.equal(history[0].message, 'Update files');
    assert.deepEqual((await gitService.historyFiles('workspace', history[0].hash)).sort(), [
      'one.txt',
      'two.txt',
    ]);
    const result = await gitService.historyDiff('workspace', history[0].hash, 'one.txt');
    assert.match(result.diff, /\+second/);
    assert.doesNotMatch(result.diff, /two\.txt/);
    await assert.rejects(() => gitService.historyDiff('workspace', history[0].hash, 'missing.txt'));
  } finally {
    workspaceService.getRoot = original;
    await rm(root, { recursive: true, force: true });
  }
});
