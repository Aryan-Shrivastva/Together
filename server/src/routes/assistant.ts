import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { SlidingWindowRateLimiter } from '../middleware/rateLimit.js';
import { assistantService } from '../services/assistantService.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

export const assistantRouter = Router();
const limiter = new SlidingWindowRateLimiter(60_000, 6);

assistantRouter.post('/workspaces/:workspaceId/assistant/test', async (req, res, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    if (!req.authUser?.sub) throw new HttpError(401, 'Authentication is required.');
    await membershipService.requireEditor(workspaceId, req.authUser.sub);
    if (!limiter.check(req.authUser.sub).allowed)
      throw new HttpError(429, 'Please wait before running another task.');
    const { branchId } = z.object({ branchId: z.string().cuid() }).strict().parse(req.body);
    res
      .status(201)
      .json({ message: await assistantService.runTests(workspaceId, req.authUser.sub, branchId) });
  } catch (error) {
    next(error);
  }
});

assistantRouter.get('/workspaces/:workspaceId/assistant', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    if (!req.authUser?.sub) throw new HttpError(401, 'Authentication is required.');
    await membershipService.requireMember(id, req.authUser.sub);
    const messages = await prisma.assistantMessage.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { id: true, username: true } } },
    });
    res.json({ messages: messages.reverse() });
  } catch (error) {
    next(error);
  }
});

assistantRouter.post('/workspaces/:workspaceId/assistant', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    if (!req.authUser?.sub) throw new HttpError(401, 'Authentication is required.');
    await membershipService.requireEditor(id, req.authUser.sub);
    if (!limiter.check(req.authUser.sub).allowed)
      throw new HttpError(429, 'Please wait before asking the assistant again.');
    const { question, path, edit } = z
      .object({
        question: z.string().trim().min(1).max(4000),
        path: z.string().trim().min(1).max(1024).optional(),
        edit: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json({ message: await assistantService.ask(id, req.authUser.sub, question, path, edit) });
  } catch (error) {
    next(error);
  }
});
