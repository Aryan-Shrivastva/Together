import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors/httpError.js';
import { branchService } from '../services/branchService.js';
import { activityService } from '../services/activityService.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

const branchId = z.string().cuid();
const body = z.object({ task: z.string().trim().min(1).max(48) }).strict();
export const branchRouter = Router();
async function member(workspaceId: string, userId?: string) {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireMember(workspaceId, userId);
  return userId;
}
async function editor(workspaceId: string, userId?: string) {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireEditor(workspaceId, userId);
  return userId;
}
branchRouter.get('/workspaces/:workspaceId/branches', async (req, res, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    await member(workspaceId, req.authUser?.sub);
    res.json({ branches: await branchService.list(workspaceId) });
  } catch (e) {
    next(e);
  }
});
branchRouter.post('/workspaces/:workspaceId/branches', async (req, res, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    const userId = await editor(workspaceId, req.authUser?.sub);
    const input = body.parse(req.body);
    const user = await (
      await import('../db/client.js')
    ).prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (!user) throw new HttpError(401, 'User not found.');
    const branch = await branchService.create(workspaceId, userId, user.username, input.task);
    await activityService.log(workspaceId, userId, 'branch.created', input.task);
    res.status(201).json({ branch });
  } catch (e) {
    next(e);
  }
});
branchRouter.get('/workspaces/:workspaceId/branches/:branchId/diff', async (req, res, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    await member(workspaceId, req.authUser?.sub);
    res.json(await branchService.diff(workspaceId, branchId.parse(req.params.branchId)));
  } catch (e) {
    next(e);
  }
});

branchRouter.post('/workspaces/:workspaceId/branches/:branchId/merge', async (req, res, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    const userId = await member(workspaceId, req.authUser?.sub);
    await membershipService.requireOwner(workspaceId, userId);
    const result = await branchService.merge(workspaceId, branchId.parse(req.params.branchId));
    await activityService.log(workspaceId, userId, 'branch.merged');
    res.json({ result });
  } catch (e) {
    next(e);
  }
});

branchRouter.delete('/workspaces/:workspaceId/branches/:branchId', async (req, res, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    const userId = await member(workspaceId, req.authUser?.sub);
    await membershipService.requireOwner(workspaceId, userId);
    const result = await branchService.discard(workspaceId, branchId.parse(req.params.branchId));
    await activityService.log(workspaceId, userId, 'branch.discarded');
    res.json({ result });
  } catch (e) {
    next(e);
  }
});
