import { mkdir, readdir, readFile, rename, rm, stat, writeFile, lstat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import { env } from '../config/env.js';
import { HttpError } from '../errors/httpError.js';
import { workspaceService } from './workspaceService.js';

export type FileTreeNode = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  children?: FileTreeNode[];
};

type CreateFileInput = {
  path: string;
  kind: 'file' | 'directory';
  content: string;
};

export class FileService {
  async listTree(workspaceId: string): Promise<FileTreeNode[]> {
    const workspaceRoot = workspaceService.getRoot(workspaceId);
    let entryCount = 0;

    const visit = async (directoryPath: string, relativePath: string): Promise<FileTreeNode[]> => {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      const nodes: FileTreeNode[] = [];

      for (const entry of entries) {
        if (entry.name === '.git' || entry.isSymbolicLink()) {
          continue;
        }

        entryCount += 1;
        if (entryCount > env.FILE_TREE_MAX_ENTRIES) {
          throw new HttpError(413, 'The workspace has too many files to display.');
        }

        const nodePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const absolutePath = `${directoryPath}/${entry.name}`;

        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: nodePath,
            kind: 'directory',
            children: await visit(absolutePath, nodePath),
          });
        } else if (entry.isFile()) {
          nodes.push({ name: entry.name, path: nodePath, kind: 'file' });
        }
      }

      return nodes.sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'directory' ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
    };

    try {
      return await visit(workspaceRoot, '');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new HttpError(404, 'The workspace files are not available yet.');
      }

      throw error;
    }
  }

  async readTextFile(
    workspaceId: string,
    path: string,
  ): Promise<{ path: string; content: string }> {
    const absolutePath = await workspaceService.resolveFilePath(workspaceId, path);
    const details = await this.getExistingFileDetails(absolutePath);

    if (!details.isFile()) {
      throw new HttpError(400, 'The requested path is not a file.');
    }

    if (details.size > env.MAX_FILE_OPEN_BYTES) {
      throw new HttpError(413, 'The file is too large to open.');
    }

    const content = await readFile(absolutePath);
    if (content.includes(0)) {
      throw new HttpError(415, 'Binary files cannot be opened as text.');
    }

    return { path, content: content.toString('utf8') };
  }

  async create(workspaceId: string, input: CreateFileInput): Promise<void> {
    const absolutePath = await workspaceService.resolveFilePath(workspaceId, input.path);
    await this.assertDoesNotExist(absolutePath);
    await this.assertParentDirectory(absolutePath);

    if (input.kind === 'directory') {
      await mkdir(absolutePath);
      return;
    }

    if (Buffer.byteLength(input.content, 'utf8') > env.MAX_FILE_OPEN_BYTES) {
      throw new HttpError(413, 'The file content exceeds the allowed size.');
    }

    await writeFile(absolutePath, input.content, { encoding: 'utf8', flag: 'wx' });
  }

  async writeTextFile(workspaceId: string, path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > env.MAX_FILE_OPEN_BYTES) {
      throw new HttpError(413, 'The file content exceeds the allowed size.');
    }

    const absolutePath = await workspaceService.resolveFilePath(workspaceId, path);
    const details = await this.getExistingFileDetails(absolutePath);
    if (!details.isFile()) {
      throw new HttpError(400, 'The requested path is not a file.');
    }

    await writeFile(absolutePath, content, { encoding: 'utf8', flag: 'w' });
  }

  async move(workspaceId: string, path: string, targetPath: string): Promise<void> {
    const sourcePath = await workspaceService.resolveFilePath(workspaceId, path);
    const destinationPath = await workspaceService.resolveFilePath(workspaceId, targetPath);
    const sourceDetails = await this.getExistingFileDetails(sourcePath);
    await this.assertDoesNotExist(destinationPath);
    await this.assertParentDirectory(destinationPath);

    if (sourceDetails.isDirectory()) {
      const destinationRelativeToSource = relative(sourcePath, destinationPath);
      if (
        destinationRelativeToSource.length === 0 ||
        (!destinationRelativeToSource.startsWith('..') && destinationRelativeToSource !== '..')
      ) {
        throw new HttpError(400, 'A directory cannot be moved inside itself.');
      }
    }

    await rename(sourcePath, destinationPath);
  }

  async delete(workspaceId: string, path: string): Promise<void> {
    const absolutePath = await workspaceService.resolveFilePath(workspaceId, path);
    await this.getExistingFileDetails(absolutePath);
    await rm(absolutePath, { recursive: true, force: false });
  }

  private async getExistingFileDetails(path: string) {
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        throw new HttpError(400, 'Symbolic links are not supported in workspace files.');
      }

      return details;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new HttpError(404, 'The file or directory does not exist.');
      }

      throw error;
    }
  }

  private async assertDoesNotExist(path: string): Promise<void> {
    try {
      await lstat(path);
      throw new HttpError(409, 'A file or directory already exists at that path.');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }

  private async assertParentDirectory(path: string): Promise<void> {
    try {
      const details = await stat(dirname(path));
      if (!details.isDirectory()) {
        throw new HttpError(400, 'The destination parent must be a directory.');
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new HttpError(404, 'The destination parent directory does not exist.');
      }

      throw error;
    }
  }
}

export const fileService = new FileService();
