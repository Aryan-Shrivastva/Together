import { request as createHttpRequest } from 'node:http';

import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { membershipService } from '../services/membershipService.js';
import { previewService } from '../services/previewService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

const previewIdSchema = z.string().cuid();

async function requireMember(workspaceId: string, userId: string | undefined) {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireMember(workspaceId, userId);
}
async function requireEditor(workspaceId: string, userId: string | undefined) {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireEditor(workspaceId, userId);
}

export const previewRouter = Router();
export const previewProxyRouter = Router();

previewRouter.get('/workspaces/:workspaceId/preview', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireMember(workspaceId, request.authUser?.sub);
    response.json({ preview: await previewService.get(workspaceId) });
  } catch (error) {
    next(error);
  }
});

previewRouter.post('/workspaces/:workspaceId/preview', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireEditor(workspaceId, request.authUser?.sub);
    response.status(200).json({ preview: await previewService.launch(workspaceId) });
  } catch (error) {
    next(error);
  }
});

previewRouter.delete('/workspaces/:workspaceId/preview', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireEditor(workspaceId, request.authUser?.sub);
    response.status(200).json({ preview: await previewService.stop(workspaceId) });
  } catch (error) {
    next(error);
  }
});

previewProxyRouter.use('/:previewId', async (request, response, next) => {
  try {
    const previewId = previewIdSchema.parse(request.params.previewId);
    const target = await previewService.resolveProxy(previewId);
    await requireMember(target.workspaceId, request.authUser?.sub);
    const prefix = `/preview/${previewId}`;
    const path = request.originalUrl.startsWith(prefix)
      ? request.originalUrl.slice(prefix.length) || '/'
      : '/';
    const headers = { ...request.headers, host: `${target.host}:${target.port}` };
    delete headers.cookie;

    const upstream = createHttpRequest(
      {
        hostname: target.host,
        port: target.port,
        path,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        // Workspace code must never be able to overwrite Together's auth cookie.
        delete responseHeaders['set-cookie'];
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once('error', () => next(new HttpError(502, 'The preview is not responding yet.')));
    request.pipe(upstream);
  } catch (error) {
    next(error);
  }
});
