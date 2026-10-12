import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { fileService } from '../services/fileService.js';
import { membershipService } from '../services/membershipService.js';
import { emitFileSystemChanged } from '../sockets/workspaceSockets.js';

const workspaceIdSchema = z.string().uuid();
const filePathSchema = z.string().min(1).max(1_024);
const createFileSchema = z
  .object({
    path: filePathSchema,
    kind: z.enum(['file', 'directory']),
    content: z.string().max(2_000_000).default(''),
  })
  .strict();
const moveFileSchema = z
  .object({
    path: filePathSchema,
    targetPath: filePathSchema,
  })
  .strict();

function getAuthenticatedUserId(userId: string | undefined): string {
  if (!userId) {
    throw new HttpError(401, 'Authentication is required.');
  }

  return userId;
}

export const fileRouter = Router();

fileRouter.get('/workspaces/:workspaceId/tree', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const userId = getAuthenticatedUserId(request.authUser?.sub);
    await membershipService.requireMember(workspaceId, userId);

    response.status(200).json({ tree: await fileService.listTree(workspaceId) });
  } catch (error) {
    next(error);
  }
});

fileRouter.get('/workspaces/:workspaceId/file', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const path = filePathSchema.parse(request.query.path);
    const userId = getAuthenticatedUserId(request.authUser?.sub);
    await membershipService.requireMember(workspaceId, userId);

    response.status(200).json(await fileService.readTextFile(workspaceId, path));
  } catch (error) {
    next(error);
  }
});

fileRouter.post('/workspaces/:workspaceId/file', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const input = createFileSchema.parse(request.body);
    const userId = getAuthenticatedUserId(request.authUser?.sub);
    await membershipService.requireMember(workspaceId, userId);
    await fileService.create(workspaceId, input);
    emitFileSystemChanged(workspaceId);

    response.status(201).json({ path: input.path });
  } catch (error) {
    next(error);
  }
});

fileRouter.patch('/workspaces/:workspaceId/file', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const input = moveFileSchema.parse(request.body);
    const userId = getAuthenticatedUserId(request.authUser?.sub);
    await membershipService.requireMember(workspaceId, userId);
    await fileService.move(workspaceId, input.path, input.targetPath);
    emitFileSystemChanged(workspaceId);

    response.status(200).json({ path: input.targetPath });
  } catch (error) {
    next(error);
  }
});

fileRouter.delete('/workspaces/:workspaceId/file', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    const path = filePathSchema.parse(request.query.path);
    const userId = getAuthenticatedUserId(request.authUser?.sub);
    await membershipService.requireMember(workspaceId, userId);
    await fileService.delete(workspaceId, path);
    emitFileSystemChanged(workspaceId);

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});
