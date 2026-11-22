import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { activityService } from '../services/activityService.js';
import { versionService } from '../services/versionService.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

export const activityRouter = Router();

activityRouter.get('/workspaces/:workspaceId/versions', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    if (!userId) throw new HttpError(401, 'Authentication is required.');
    response.json(await versionService.unread(workspaceId, userId));
  } catch (error) {
    next(error);
  }
});

activityRouter.post(
  '/workspaces/:workspaceId/versions/reviewed',
  async (request, response, next) => {
    try {
      const userId = request.authUser?.sub;
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      const { activityId } = z
        .object({ activityId: z.string().cuid() })
        .strict()
        .parse(request.body);
      if (!userId) throw new HttpError(401, 'Authentication is required.');
      await membershipService.requireMember(workspaceId, userId);
      await versionService.markReviewed(workspaceId, userId, activityId);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

activityRouter.get('/workspaces/:workspaceId/activity', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    if (!userId) throw new HttpError(401, 'Authentication is required.');
    await membershipService.requireMember(workspaceId, userId);
    response.json({ activity: await activityService.list(workspaceId) });
  } catch (error) {
    next(error);
  }
});
