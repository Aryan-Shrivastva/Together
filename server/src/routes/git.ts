import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors/httpError.js';
import { gitRateLimit } from '../middleware/rateLimit.js';
import { gitService } from '../services/gitService.js';
import { membershipService } from '../services/membershipService.js';
import { emitFileSystemChanged } from '../sockets/workspaceSockets.js';

const workspaceIdSchema = z.string().uuid();
const commitSchema = z
  .object({
    message: z.string().trim().min(1).max(500),
    files: z.array(z.string().min(1).max(1_024)).max(500).optional(),
  })
  .strict();

export const gitRouter = Router();
gitRouter.use(gitRateLimit);

async function requireMember(workspaceId: string, userId: string | undefined) {
  if (!userId) {
    throw new HttpError(401, 'Authentication is required.');
  }

  return membershipService.requireMember(workspaceId, userId);
}

gitRouter.get('/workspaces/:workspaceId/git/status', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireMember(workspaceId, request.authUser?.sub);
    response.status(200).json({ status: await gitService.status(workspaceId) });
  } catch (error) {
    next(error);
  }
});

gitRouter.post('/workspaces/:workspaceId/git/commit', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const userId = request.authUser?.sub;
    await requireMember(workspaceId, userId);
    const input = commitSchema.parse(request.body);
    await gitService.commit(workspaceId, userId!, input.message, input.files);
    response.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

gitRouter.post('/workspaces/:workspaceId/git/pull', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireMember(workspaceId, request.authUser?.sub);
    await gitService.pull(workspaceId);
    emitFileSystemChanged(workspaceId);
    response.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

gitRouter.post('/workspaces/:workspaceId/git/push', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const membership = await requireMember(workspaceId, request.authUser?.sub);
    if (membership.role !== 'OWNER') {
      throw new HttpError(403, 'Only the workspace owner can push to GitHub.');
    }

    await gitService.push(workspaceId);
    response.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
});
