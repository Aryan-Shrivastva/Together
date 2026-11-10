import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors/httpError.js';
import { gitRateLimit } from '../middleware/rateLimit.js';
import { activityService } from '../services/activityService.js';
import { gitService } from '../services/gitService.js';
import { membershipService } from '../services/membershipService.js';
import { emitFileSystemChanged } from '../sockets/workspaceSockets.js';
import { workspaceIdSchema } from '../validation/workspace.js';

const commitSchema = z
  .object({
    message: z.string().trim().min(1).max(500),
    files: z.array(z.string().min(1).max(1_024)).max(500).optional(),
  })
  .strict();

export const gitRouter = Router();

async function requireMember(workspaceId: string, userId: string | undefined) {
  if (!userId) {
    throw new HttpError(401, 'Authentication is required.');
  }

  return membershipService.requireMember(workspaceId, userId);
}

async function requireEditor(workspaceId: string, userId: string | undefined) {
  if (!userId) {
    throw new HttpError(401, 'Authentication is required.');
  }

  return membershipService.requireEditor(workspaceId, userId);
}

gitRouter.get(
  '/workspaces/:workspaceId/git/status',
  gitRateLimit,
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      await requireMember(workspaceId, request.authUser?.sub);
      response.status(200).json({ status: await gitService.status(workspaceId) });
    } catch (error) {
      next(error);
    }
  },
);

gitRouter.post(
  '/workspaces/:workspaceId/git/commit',
  gitRateLimit,
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      const userId = request.authUser?.sub;
      await requireEditor(workspaceId, userId);
      const input = commitSchema.parse(request.body);
      await gitService.commit(workspaceId, userId!, input.message, input.files);
      await activityService.log(workspaceId, userId, 'git.committed', input.message);
      response.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

gitRouter.post(
  '/workspaces/:workspaceId/git/pull',
  gitRateLimit,
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      await requireEditor(workspaceId, request.authUser?.sub);
      await gitService.pull(workspaceId);
      await activityService.log(workspaceId, request.authUser?.sub, 'git.pulled');
      emitFileSystemChanged(workspaceId);
      response.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

gitRouter.post(
  '/workspaces/:workspaceId/git/push',
  gitRateLimit,
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      const membership = await requireMember(workspaceId, request.authUser?.sub);
      if (membership.role !== 'OWNER') {
        throw new HttpError(403, 'Only the workspace owner can push to GitHub.');
      }

      await gitService.push(workspaceId);
      await activityService.log(workspaceId, request.authUser?.sub, 'git.pushed');
      response.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);
