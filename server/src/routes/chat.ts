import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { chatHistoryRateLimit } from '../middleware/rateLimit.js';
import { membershipService } from '../services/membershipService.js';

const workspaceIdSchema = z.string().uuid();
const querySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const chatRouter = Router();
chatRouter.use(chatHistoryRateLimit);

chatRouter.get('/workspaces/:workspaceId/messages', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    if (!userId) throw new HttpError(401, 'Authentication is required.');
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const { before, limit } = querySchema.parse(request.query);
    await membershipService.requireMember(workspaceId, userId);
    const messages = await prisma.chatMessage.findMany({
      where: { workspaceId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { id: true, username: true, avatarUrl: true } } },
    });
    response.status(200).json({ messages: messages.reverse() });
  } catch (error) {
    next(error);
  }
});
