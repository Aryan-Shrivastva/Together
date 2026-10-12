import { Octokit } from 'octokit';

import { decryptGitHubToken } from '../auth/crypto.js';
import { getAuthenticationConfig } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';

export type RepositorySummary = {
  fullName: string;
  name: string;
  isPrivate: boolean;
  defaultBranch: string;
};

export type CloneRepository = RepositorySummary & {
  cloneUrl: string;
};

function getGitHubErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status;
  }

  return undefined;
}

function repositoryAccessError(error: unknown): HttpError {
  const status = getGitHubErrorStatus(error);

  if (status === 401) {
    return new HttpError(401, 'Your GitHub authorization has expired. Sign out and sign in again.');
  }

  if (status === 403) {
    return new HttpError(
      403,
      'GitHub did not grant permission to list repositories. Sign out and sign in again to approve repository access.',
    );
  }

  return new HttpError(502, 'GitHub could not provide your repositories. Please try again.');
}

function parseRepositoryFullName(fullName: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName);

  if (!match) {
    throw new HttpError(400, 'Repository name must use the owner/repository format.');
  }

  const owner = match[1];
  const repo = match[2];

  if (!owner || !repo) {
    throw new HttpError(400, 'Repository name must use the owner/repository format.');
  }

  return { owner, repo };
}

export class GitHubService {
  private async getOctokitForUser(userId: string): Promise<Octokit> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { githubAccessTokenEncrypted: true },
    });

    if (!user) {
      throw new HttpError(401, 'Your user account no longer exists.');
    }

    try {
      const config = getAuthenticationConfig();
      const accessToken = decryptGitHubToken(
        user.githubAccessTokenEncrypted,
        config.TOKEN_ENCRYPTION_KEY,
      );

      return new Octokit({ auth: accessToken });
    } catch {
      throw new HttpError(401, 'Your GitHub connection is no longer valid. Sign in again.');
    }
  }

  async listRepositories(userId: string): Promise<RepositorySummary[]> {
    try {
      const octokit = await this.getOctokitForUser(userId);
      const repositories = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        affiliation: 'owner,collaborator,organization_member',
        direction: 'desc',
        per_page: 100,
        sort: 'updated',
      });

      return repositories
        .filter((repository) => !repository.archived && repository.full_name)
        .map((repository) => ({
          fullName: repository.full_name,
          name: repository.name,
          isPrivate: repository.private,
          defaultBranch: repository.default_branch ?? 'main',
        }));
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      const status = getGitHubErrorStatus(error);
      console.warn('GitHub repository listing failed.', { userId, status });
      throw repositoryAccessError(error);
    }
  }

  async getCloneRepository(userId: string, fullName: string): Promise<CloneRepository> {
    const { owner, repo } = parseRepositoryFullName(fullName);

    try {
      const octokit = await this.getOctokitForUser(userId);
      const response = await octokit.rest.repos.get({ owner, repo });
      const repository = response.data;

      if (!repository.full_name || !repository.clone_url) {
        throw new HttpError(502, 'GitHub returned incomplete repository information.');
      }

      return {
        fullName: repository.full_name,
        name: repository.name,
        isPrivate: repository.private,
        defaultBranch: repository.default_branch ?? 'main',
        cloneUrl: repository.clone_url,
      };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      const status = getGitHubErrorStatus(error);
      console.warn('GitHub repository lookup failed.', { userId, status });
      throw repositoryAccessError(error);
    }
  }
}

export const gitHubService = new GitHubService();
