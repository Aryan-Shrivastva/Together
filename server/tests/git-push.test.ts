import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prisma } from '../src/db/client.js';
import { encryptGitHubToken } from '../src/auth/crypto.js';
import { gitService } from '../src/services/gitService.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { collaborationService } from '../src/services/collaborationService.js';

test('authenticated Git push transfers commits and reports rejected pushes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'together-git-push-'));
  const local = join(root, 'local');
  const remote = join(root, 'remote.git');
  const key = Buffer.alloc(32, 1).toString('base64');
  const env = {
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    GITHUB_OAUTH_REDIRECT_URL: 'http://localhost/callback',
    JWT_SECRET: key,
    TOKEN_ENCRYPTION_KEY: key,
  };
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  const oldRoot = workspaceService.getRoot;
  const oldFlush = collaborationService.flushWorkspace;
  const oldWorkspace = prisma.workspace.findUnique;
  const oldUser = prisma.user.findUnique;
  workspaceService.getRoot = () => local;
  collaborationService.flushWorkspace = async () => {};
  prisma.workspace.findUnique = (async () => ({
    ownerId: 'user',
  })) as typeof prisma.workspace.findUnique;
  prisma.user.findUnique = (async () => ({
    githubAccessTokenEncrypted: encryptGitHubToken('test-token', key),
  })) as typeof prisma.user.findUnique;
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
  try {
    git('init', '--bare', remote);
    git('init', '-b', 'main', local);
    git('-C', local, 'config', 'user.name', 'Test');
    git('-C', local, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(local, 'file.txt'), 'test');
    git('-C', local, 'add', '.');
    git('-C', local, 'commit', '-m', 'Initial');
    git('-C', local, 'remote', 'add', 'origin', remote);
    await gitService.push('workspace');
    assert.equal(
      git('--git-dir', remote, 'rev-parse', 'refs/heads/main').trim(),
      git('-C', local, 'rev-parse', 'HEAD').trim(),
    );
    git('-C', local, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    await assert.rejects(() => gitService.push('workspace'), /Git push failed/);
  } finally {
    workspaceService.getRoot = oldRoot;
    collaborationService.flushWorkspace = oldFlush;
    prisma.workspace.findUnique = oldWorkspace;
    prisma.user.findUnique = oldUser;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  }
});
