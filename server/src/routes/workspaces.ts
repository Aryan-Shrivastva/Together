import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { cloneService } from '../services/cloneService.js';
import { gitHubService } from '../services/githubService.js';
import { workspaceService } from '../services/workspaceService.js';

const workspaceIdSchema = z.string().uuid();
const createWorkspaceSchema = z
  .object({
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  })
  .strict();

function toWorkspaceResponse(
  workspace: {
    id: string;
    name: string;
    repoFullName: string;
    defaultBranch: string;
    status: 'CLONING' | 'READY' | 'ERROR';
    createdAt: Date;
  },
  role: 'OWNER' | 'COLLABORATOR',
) {
  return {
    id: workspace.id,
    name: workspace.name,
    repoFullName: workspace.repoFullName,
    defaultBranch: workspace.defaultBranch,
    status: workspace.status,
    createdAt: workspace.createdAt,
    role,
    errorMessage:
      workspace.status === 'ERROR'
        ? (cloneService.getFailureMessage(workspace.id) ?? 'The repository could not be cloned.')
        : undefined,
  };
}

export const workspaceRouter = Router();

workspaceRouter.get('/repos', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;

    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const repositories = await gitHubService.listRepositories(userId);
    response.status(200).json({ repositories });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.get('/workspaces', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;

    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { workspace: { createdAt: 'desc' } },
    });

    response.status(200).json({
      workspaces: memberships.map((membership) =>
        toWorkspaceResponse(membership.workspace, membership.role),
      ),
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.get('/workspaces/:workspaceId', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);

    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
      include: { workspace: true },
    });

    if (!membership) {
      throw new HttpError(403, 'You are not a member of this workspace.');
    }

    response.status(200).json({
      workspace: toWorkspaceResponse(membership.workspace, membership.role),
    });
  } catch (error) {
    next(error);
  }
});

workspaceRouter.post('/workspaces', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const { repoFullName } = createWorkspaceSchema.parse(request.body);

    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const repository = await gitHubService.getCloneRepository(userId, repoFullName);
    const workspaceId = randomUUID();
    const diskPath = workspaceService.getRoot(workspaceId);
    const workspace = await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
      const createdWorkspace = await transaction.workspace.create({
        data: {
          id: workspaceId,
          name: repository.name,
          repoFullName: repository.fullName,
          repoCloneUrl: repository.cloneUrl,
          defaultBranch: repository.defaultBranch,
          ownerId: userId,
          diskPath,
          status: 'CLONING',
        },
      });

      await transaction.workspaceMember.create({
        data: {
          workspaceId: createdWorkspace.id,
          userId,
          role: 'OWNER',
        },
      });

      return createdWorkspace;
    });

    cloneService.start(workspace.id);
    response.status(202).json({ workspace: toWorkspaceResponse(workspace, 'OWNER') });
  } catch (error) {
    next(error);
  }
});
