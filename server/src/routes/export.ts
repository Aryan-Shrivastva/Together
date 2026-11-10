import { Router } from 'express';

import { HttpError } from '../errors/httpError.js';
import { activityService } from '../services/activityService.js';
import { collaborationService } from '../services/collaborationService.js';
import { exportService } from '../services/exportService.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

export const exportRouter = Router();

exportRouter.get('/workspaces/:workspaceId/export', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    if (!userId) throw new HttpError(401, 'Authentication is required.');
    await membershipService.requireMember(workspaceId, userId);
    await collaborationService.flushWorkspace(workspaceId);
    const archive = await exportService.create(workspaceId);
    await activityService.log(workspaceId, userId, 'workspace.exported');
    response
      .status(200)
      .type('application/zip')
      .set('Content-Disposition', 'attachment; filename="together-workspace.zip"')
      .send(archive);
  } catch (error) {
    next(error);
  }
});
