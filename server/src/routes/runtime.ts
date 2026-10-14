import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { membershipService } from '../services/membershipService.js';
import { runtimeService } from '../services/runtimeService.js';

const workspaceIdSchema = z.string().uuid();

async function requireMember(workspaceId: string, userId: string | undefined): Promise<void> {
  if (!userId) {
    throw new HttpError(401, 'Authentication is required.');
  }
  await membershipService.requireMember(workspaceId, userId);
}

export const runtimeRouter = Router();

runtimeRouter.get('/workspaces/:workspaceId/runtime', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireMember(workspaceId, request.authUser?.sub);
    response.status(200).json({ runtime: await runtimeService.getStatus(workspaceId) });
  } catch (error) {
    next(error);
  }
});

runtimeRouter.post('/workspaces/:workspaceId/runtime/start', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireMember(workspaceId, request.authUser?.sub);
    response.status(200).json({ runtime: await runtimeService.start(workspaceId) });
  } catch (error) {
    next(error);
  }
});

runtimeRouter.post('/workspaces/:workspaceId/runtime/install', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireMember(workspaceId, request.authUser?.sub);
    response.status(200).json(await runtimeService.installDependencies(workspaceId));
  } catch (error) {
    next(error);
  }
});
