import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { dependencyOrchestrator } from '../depforge/orchestrator.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

const actionSchema = z.object({
  package: z.string().min(1).max(256),
  action: z.enum(['upgrade', 'replace', 'pin']),
  current: z.string().nullable().default(null),
  target: z.string().min(1).max(128),
  sourceFile: z.string().min(1).max(256),
  replacementPackage: z.string().nullable().default(null),
});

function publicState<T extends { workspacePath: string }>(state: T): Omit<T, 'workspacePath'> {
  const { workspacePath, ...safeState } = state;
  void workspacePath;
  return safeState;
}

async function requireEditor(workspaceId: string, userId: string | undefined): Promise<void> {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireEditor(workspaceId, userId);
}

export const depforgeRouter = Router();

depforgeRouter.get('/workspaces/:workspaceId/depforge/runs', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireEditor(workspaceId, request.authUser?.sub);
    const runs = await dependencyOrchestrator.listRuns(workspaceId);
    response.status(200).json({ runs: runs.map(publicState) });
  } catch (error) {
    next(error);
  }
});

depforgeRouter.post('/workspaces/:workspaceId/depforge/runs', async (request, response, next) => {
  try {
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    await requireEditor(workspaceId, request.authUser?.sub);
    response
      .status(201)
      .json({ run: publicState(await dependencyOrchestrator.createRun(workspaceId)) });
  } catch (error) {
    next(error);
  }
});

depforgeRouter.get(
  '/workspaces/:workspaceId/depforge/runs/:runId',
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      await requireEditor(workspaceId, request.authUser?.sub);
      const run = await dependencyOrchestrator.getRun(workspaceId, request.params.runId ?? '');
      response
        .status(200)
        .json({ run: publicState(run), report: dependencyOrchestrator.report(workspaceId, run) });
    } catch (error) {
      next(error);
    }
  },
);

depforgeRouter.post(
  '/workspaces/:workspaceId/depforge/runs/:runId/approve',
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      await requireEditor(workspaceId, request.authUser?.sub);
      const body = z.object({ actions: z.array(actionSchema).max(50) }).parse(request.body);
      const run = await dependencyOrchestrator.approveAndExecute(
        workspaceId,
        request.params.runId ?? '',
        body.actions,
      );
      response
        .status(200)
        .json({ run: publicState(run), report: dependencyOrchestrator.report(workspaceId, run) });
    } catch (error) {
      next(error);
    }
  },
);

depforgeRouter.post(
  '/workspaces/:workspaceId/depforge/runs/:runId/reject',
  async (request, response, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      await requireEditor(workspaceId, request.authUser?.sub);
      const run = await dependencyOrchestrator.reject(workspaceId, request.params.runId ?? '');
      response
        .status(200)
        .json({ run: publicState(run), report: dependencyOrchestrator.report(workspaceId, run) });
    } catch (error) {
      next(error);
    }
  },
);
