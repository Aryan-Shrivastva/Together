import { Router } from 'express';

import { HttpError } from '../errors/httpError.js';
import { activityService } from '../services/activityService.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

export const activityRouter = Router();

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
