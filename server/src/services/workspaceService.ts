import { lstat, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { env } from '../config/env.js';
import { HttpError } from '../errors/httpError.js';

export class WorkspaceService {
  private readonly rootDirectory = resolve(env.WORKSPACE_ROOT);

  getRoot(workspaceId: string): string {
    const workspaceRoot = resolve(this.rootDirectory, workspaceId);
    const relativePath = relative(this.rootDirectory, workspaceRoot);

    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new HttpError(400, 'Invalid workspace path.');
    }

    return workspaceRoot;
  }

  async resolveFilePath(workspaceId: string, requestedPath: string): Promise<string> {
    const segments = this.getSafePathSegments(requestedPath);
    const workspaceRoot = this.getRoot(workspaceId);
    await this.assertNoSymlink(workspaceRoot);

    let currentPath = workspaceRoot;
    for (const segment of segments) {
      currentPath = join(currentPath, segment);
      await this.assertNoSymlink(currentPath, true);
    }

    const resolvedPath = resolve(workspaceRoot, ...segments);
    const relativePath = relative(workspaceRoot, resolvedPath);

    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new HttpError(400, 'The file path must stay inside the workspace.');
    }

    return resolvedPath;
  }

  private getSafePathSegments(requestedPath: string): string[] {
    if (
      requestedPath.length === 0 ||
      requestedPath.length > 1_024 ||
      requestedPath.includes('\0') ||
      requestedPath.includes('\\') ||
      requestedPath.startsWith('/') ||
      isAbsolute(requestedPath)
    ) {
      throw new HttpError(400, 'The file path is invalid.');
    }

    const segments = requestedPath.split('/');
    if (
      segments.some(
        (segment) =>
          segment.length === 0 || segment === '.' || segment === '..' || segment === '.git',
      )
    ) {
      throw new HttpError(400, 'The file path is invalid.');
    }

    return segments;
  }

  private async assertNoSymlink(path: string, allowMissing = false): Promise<void> {
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        throw new HttpError(400, 'Symbolic links are not supported in workspace files.');
      }
    } catch (error) {
      if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }

  async prepareEmptyRoot(workspaceId: string): Promise<string> {
    const workspaceRoot = this.getRoot(workspaceId);
    await mkdir(this.rootDirectory, { recursive: true });

    try {
      await mkdir(workspaceRoot);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new HttpError(409, 'A workspace directory already exists.');
      }

      throw error;
    }

    return workspaceRoot;
  }

  async removeRoot(workspaceId: string): Promise<void> {
    const workspaceRoot = this.getRoot(workspaceId);

    try {
      const details = await lstat(workspaceRoot);

      if (details.isSymbolicLink()) {
        await rm(workspaceRoot, { force: true });
        return;
      }

      await rm(workspaceRoot, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }
}

export const workspaceService = new WorkspaceService();
