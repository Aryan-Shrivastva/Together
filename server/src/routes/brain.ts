import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { brainRateLimit } from '../middleware/rateLimit.js';
import { brainService } from '../services/brainService.js';
import { membershipService } from '../services/membershipService.js';

const workspaceIdSchema = z.string().uuid();
const askSchema = z
  .object({
    question: z.string().trim().min(2).max(500),
  })
  .strict();

export const brainRouter = Router();
brainRouter.use(brainRateLimit);

brainRouter.post('/workspaces/:workspaceId/brain', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const { question } = askSchema.parse(request.body);
    await membershipService.requireMember(workspaceId, userId);
    response.status(200).json(await brainService.ask(workspaceId, question));
  } catch (error) {
    next(error);
  }
});
