import { simpleGit } from 'simple-git';
import { resolve } from 'node:path';

import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { collaborationService } from './collaborationService.js';
import { previewService } from './previewService.js';
import { runtimeService } from './runtimeService.js';
import { workspaceService } from './workspaceService.js';

const taskPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

export class BranchService {
  async list(workspaceId: string) {
    return prisma.branch.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  async create(workspaceId: string, userId: string, username: string, task: string) {
    if (!taskPattern.test(task))
      throw new HttpError(400, 'Task names may use lowercase letters, numbers, and hyphens only.');
    await collaborationService.flushWorkspace(workspaceId);
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        defaultBranch: true,
        name: true,
        repoFullName: true,
        repoCloneUrl: true,
        ownerId: true,
        members: { select: { userId: true, role: true } },
      },
    });
    if (!workspace) throw new HttpError(404, 'Workspace not found.');
    const userSlug =
      username
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || userId.slice(0, 8);
    const name = `together/${userSlug}/${task}`;
    const root = workspaceService.getRoot(workspaceId);
    const branchWorkspace = await prisma.workspace.create({
      data: {
        name: `${workspace.name} · ${task}`,
        repoFullName: workspace.repoFullName,
        repoCloneUrl: workspace.repoCloneUrl,
        defaultBranch: name,
        ownerId: workspace.ownerId,
        diskPath: '',
        status: 'CLONING',
        members: {
          create: workspace.members.map((member) => ({ userId: member.userId, role: member.role })),
        },
      },
    });
    const worktreePath = workspaceService.getRoot(branchWorkspace.id);
    const git = simpleGit(root);
    try {
      await git.raw(['worktree', 'add', '-b', name, worktreePath, workspace.defaultBranch]);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      await prisma.workspace.delete({ where: { id: branchWorkspace.id } });
      if (message.includes('already exists'))
        throw new HttpError(409, 'This task branch already exists.');
      throw new HttpError(502, 'Unable to create the branch worktree.');
    }
    await prisma.workspace.update({
      where: { id: branchWorkspace.id },
      data: { diskPath: worktreePath, status: 'READY' },
    });
    return prisma.branch.create({
      data: {
        workspaceId,
        name,
        task,
        createdById: userId,
        worktreePath,
        branchWorkspaceId: branchWorkspace.id,
      },
    });
  }

  async diff(workspaceId: string, branchId: string) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, workspaceId } });
    if (!branch) throw new HttpError(404, 'Branch not found.');
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultBranch: true },
    });
    if (!workspace) throw new HttpError(404, 'Workspace not found.');
    return {
      branch,
      diff: await simpleGit(branch.worktreePath).diff([workspace.defaultBranch, '--']),
    };
  }

  async merge(workspaceId: string, branchId: string) {
    const context = await this.getBranchContext(workspaceId, branchId);
    await collaborationService.flushWorkspace(workspaceId);
    await collaborationService.flushWorkspace(context.branchWorkspaceId);

    const mainGit = simpleGit(workspaceService.getRoot(workspaceId));
    const branchGit = simpleGit(context.worktreePath);
    const mainStatus = await mainGit.status();
    if (!mainStatus.isClean() || mainStatus.current !== context.defaultBranch) {
      throw new HttpError(
        409,
        'The main workspace must be on its default branch with no uncommitted changes before merging.',
      );
    }
    const branchStatus = await branchGit.status();
    if (!branchStatus.isClean() || branchStatus.current !== context.name) {
      throw new HttpError(
        409,
        'Commit or discard the task branch changes before merging it into main.',
      );
    }

    try {
      await mainGit.merge([context.name, '--no-edit']);
    } catch {
      try {
        await mainGit.merge(['--abort']);
      } catch {
        // Preserve the original merge failure while leaving the user a clear recovery path.
      }
      throw new HttpError(
        409,
        'Merge stopped because the branch conflicts with main. Resolve the conflict in the branch and try again.',
      );
    }

    await collaborationService.reloadWorkspace(workspaceId);
    await this.cleanupBranch(context);
    return { merged: true, branch: { id: context.id, name: context.name } };
  }

  async discard(workspaceId: string, branchId: string) {
    const context = await this.getBranchContext(workspaceId, branchId);
    await collaborationService.flushWorkspace(context.branchWorkspaceId);
    await this.cleanupBranch(context);
    return { discarded: true, branch: { id: context.id, name: context.name } };
  }

  private async getBranchContext(workspaceId: string, branchId: string) {
    const branch = await prisma.branch.findFirst({
      where: { id: branchId, workspaceId },
      select: {
        id: true,
        name: true,
        worktreePath: true,
        branchWorkspaceId: true,
        workspace: { select: { defaultBranch: true } },
      },
    });
    if (!branch || !branch.branchWorkspaceId) throw new HttpError(404, 'Branch not found.');

    const branchWorkspace = await prisma.workspace.findUnique({
      where: { id: branch.branchWorkspaceId },
      select: { id: true },
    });
    if (!branchWorkspace) throw new HttpError(404, 'The branch workspace no longer exists.');

    const expectedWorktreePath = workspaceService.getRoot(branch.branchWorkspaceId);
    if (resolve(branch.worktreePath) !== resolve(expectedWorktreePath)) {
      throw new HttpError(500, 'The branch worktree path is invalid.');
    }

    return {
      id: branch.id,
      name: branch.name,
      workspaceId,
      defaultBranch: branch.workspace.defaultBranch,
      branchWorkspaceId: branch.branchWorkspaceId,
      worktreePath: expectedWorktreePath,
    };
  }

  private async cleanupBranch(context: {
    id: string;
    name: string;
    workspaceId: string;
    branchWorkspaceId: string;
    worktreePath: string;
  }): Promise<void> {
    await previewService.stop(context.branchWorkspaceId);
    await runtimeService.stopAndCleanup(context.branchWorkspaceId);

    const mainGit = simpleGit(workspaceService.getRoot(context.workspaceId));
    try {
      await mainGit.raw(['worktree', 'remove', '--force', context.worktreePath]);
      await mainGit.raw(['branch', '-D', context.name]);
    } catch {
      throw new HttpError(
        502,
        'The branch changes were handled, but the Git worktree could not be cleaned up. Retry the cleanup.',
      );
    }

    await workspaceService.removeRoot(context.branchWorkspaceId);
    await prisma.$transaction([
      prisma.branch.delete({ where: { id: context.id } }),
      prisma.workspace.delete({ where: { id: context.branchWorkspaceId } }),
    ]);
  }
}

export const branchService = new BranchService();
