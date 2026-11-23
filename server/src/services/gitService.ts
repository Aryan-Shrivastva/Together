import { Buffer } from 'node:buffer';

import { simpleGit } from 'simple-git';

import { decryptGitHubToken } from '../auth/crypto.js';
import { env, getAuthenticationConfig } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { collaborationService } from './collaborationService.js';
import { workspaceService } from './workspaceService.js';

export class GitService {
  async history(workspaceId: string) {
    const git = await this.git(workspaceId);
    const history = await git.log({ maxCount: 30 });
    return history.all.map(({ hash, date, message, author_name }) => ({
      hash,
      date,
      message,
      author: author_name,
    }));
  }

  async historyFiles(workspaceId: string, commit: string) {
    const git = await this.git(workspaceId);
    await git.raw(['merge-base', '--is-ancestor', commit, 'HEAD']);
    const output = await git.raw([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      commit,
    ]);
    return output.split('\0').filter(Boolean).slice(0, 200);
  }

  async historyDiff(workspaceId: string, commit: string, path: string) {
    const git = await this.git(workspaceId);
    const files = await this.historyFiles(workspaceId, commit);
    if (!files.includes(path)) throw new HttpError(404, 'File not found in this commit.');
    const diff = await git.raw([
      'show',
      '--format=',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      commit,
      '--',
      `:(literal)${path}`,
    ]);
    return { diff: diff.slice(0, 100000), truncated: diff.length > 100000 };
  }
  private throwGitError(operation: 'status' | 'commit' | 'pull' | 'push', error: unknown): never {
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (message.includes('nothing to commit')) {
      throw new HttpError(409, 'There are no changes to commit.');
    }

    if (
      message.includes('conflict') ||
      message.includes('would be overwritten by merge') ||
      message.includes('not possible because you have unmerged files')
    ) {
      throw new HttpError(
        409,
        'Git pull stopped because the workspace has conflicting changes. Resolve them and try again.',
      );
    }

    if (
      message.includes('authentication failed') ||
      message.includes('could not read username') ||
      message.includes('http 401') ||
      message.includes('http 403')
    ) {
      throw new HttpError(
        502,
        'GitHub authentication failed. The workspace owner should sign out and sign in again.',
      );
    }

    if (message.includes('non-fast-forward') || message.includes('fetch first')) {
      throw new HttpError(
        409,
        'GitHub rejected the push because the remote branch has newer commits. Pull and resolve any conflicts first.',
      );
    }

    if (message.includes('could not resolve host') || message.includes('failed to connect')) {
      throw new HttpError(
        502,
        'The server could not reach GitHub. Check the network connection and try again.',
      );
    }

    console.error(`Git ${operation} failed.`);
    throw new HttpError(502, `Git ${operation} failed. Check the repository state and try again.`);
  }

  private async git(workspaceId: string, authenticated = false) {
    const options = {
      baseDir: workspaceService.getRoot(workspaceId),
      timeout: { block: env.WORKSPACE_CLONE_TIMEOUT_MS },
      unsafe: { allowUnsafeConfigEnvCount: true },
      allowEnvironment: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'],
    };
    if (!authenticated) return simpleGit(options);
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) throw new HttpError(404, 'Workspace not found.');
    const owner = await prisma.user.findUnique({
      where: { id: workspace.ownerId },
      select: { githubAccessTokenEncrypted: true },
    });
    if (!owner) throw new HttpError(500, 'Workspace owner is unavailable.');
    const token = decryptGitHubToken(
      owner.githubAccessTokenEncrypted,
      getAuthenticationConfig().TOKEN_ENCRYPTION_KEY,
    );
    const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
    return simpleGit(options).env({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    });
  }

  async status(workspaceId: string) {
    try {
      await collaborationService.flushWorkspace(workspaceId);
      return await (await this.git(workspaceId)).status();
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      return this.throwGitError('status', error);
    }
  }

  async commit(workspaceId: string, userId: string, message: string, files?: string[]) {
    try {
      await collaborationService.flushWorkspace(workspaceId);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, email: true },
      });
      if (!user) throw new HttpError(401, 'Your account no longer exists.');
      if (files) {
        await Promise.all(files.map((path) => workspaceService.resolveFilePath(workspaceId, path)));
      }
      const git = await this.git(workspaceId);
      await git.add(files?.length ? files : ['.']);
      await git.addConfig('user.name', user.username);
      await git.addConfig('user.email', user.email ?? `${user.username}@users.noreply.github.com`);
      return await git.commit(message);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      return this.throwGitError('commit', error);
    }
  }

  async pull(workspaceId: string) {
    try {
      await collaborationService.flushWorkspace(workspaceId);
      const git = await this.git(workspaceId, true);
      const before = await git.revparse(['HEAD']);
      const result = await git.pull();
      const after = await git.revparse(['HEAD']);
      await collaborationService.reloadWorkspace(workspaceId);
      return { ...result, changed: before.trim() !== after.trim() };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      return this.throwGitError('pull', error);
    }
  }

  async push(workspaceId: string) {
    try {
      await collaborationService.flushWorkspace(workspaceId);
      return await (await this.git(workspaceId, true)).push('origin', 'HEAD');
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      return this.throwGitError('push', error);
    }
  }
}
export const gitService = new GitService();
