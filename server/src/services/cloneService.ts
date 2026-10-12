import { Buffer } from 'node:buffer';

import { simpleGit } from 'simple-git';

import { decryptGitHubToken } from '../auth/crypto.js';
import { env, getAuthenticationConfig } from '../config/env.js';
import { prisma } from '../db/client.js';
import { workspaceService } from './workspaceService.js';

const GENERIC_CLONE_ERROR = 'The repository could not be cloned. Verify access and try again.';

export class CloneService {
  private readonly errors = new Map<string, string>();

  getFailureMessage(workspaceId: string): string | undefined {
    return this.errors.get(workspaceId);
  }

  start(workspaceId: string): void {
    void this.clone(workspaceId).catch(() => {
      console.error('Workspace cloning failed.');
    });
  }

  private async clone(workspaceId: string): Promise<void> {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          ownerId: true,
          repoCloneUrl: true,
        },
      });

      if (!workspace) {
        return;
      }

      const owner = await prisma.user.findUnique({
        where: { id: workspace.ownerId },
        select: { githubAccessTokenEncrypted: true },
      });

      if (!owner) {
        throw new Error('Workspace owner does not exist.');
      }

      const config = getAuthenticationConfig();
      const accessToken = decryptGitHubToken(
        owner.githubAccessTokenEncrypted,
        config.TOKEN_ENCRYPTION_KEY,
      );
      const authorization = Buffer.from(`x-access-token:${accessToken}`).toString('base64');
      const workspaceRoot = await workspaceService.prepareEmptyRoot(workspace.id);
      const git = simpleGit({
        timeout: { block: env.WORKSPACE_CLONE_TIMEOUT_MS },
        unsafe: { allowUnsafeConfigEnvCount: true },
      }).env({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      });

      await git.clone(workspace.repoCloneUrl, workspaceRoot, ['--depth=1']);
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: 'READY' },
      });
      this.errors.delete(workspace.id);
    } catch {
      await this.markFailed(workspaceId);
      throw new Error('Workspace cloning failed.');
    }
  }

  private async markFailed(workspaceId: string): Promise<void> {
    try {
      await workspaceService.removeRoot(workspaceId);
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'ERROR' },
      });
      this.errors.set(workspaceId, GENERIC_CLONE_ERROR);
    } catch {
      console.error('Workspace clone cleanup failed.');
    }
  }
}

export const cloneService = new CloneService();
