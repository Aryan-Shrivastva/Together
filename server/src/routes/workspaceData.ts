import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors/httpError.js';
import { membershipService } from '../services/membershipService.js';
import { workspaceDataService } from '../services/workspaceDataService.js';
import { workspaceIdSchema } from '../validation/workspace.js';

const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const configBody = z.object({ key, value: z.string().min(1).max(8_192) }).strict();
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/);
async function member(id: string, userId?: string) {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireMember(id, userId);
}
async function editor(id: string, userId?: string) {
  if (!userId) throw new HttpError(401, 'Authentication is required.');
  await membershipService.requireEditor(id, userId);
}
export const workspaceDataRouter = Router();
workspaceDataRouter.get('/workspaces/:workspaceId/config', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    await member(id, req.authUser?.sub);
    res.json({ config: await workspaceDataService.listConfig(id) });
  } catch (e) {
    next(e);
  }
});
workspaceDataRouter.put('/workspaces/:workspaceId/config', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    const body = configBody.parse(req.body);
    await editor(id, req.authUser?.sub);
    await workspaceDataService.setConfig(id, body.key, body.value);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});
workspaceDataRouter.delete('/workspaces/:workspaceId/config/:key', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    const configKey = key.parse(req.params.key);
    await editor(id, req.authUser?.sub);
    await workspaceDataService.deleteConfig(id, configKey);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});
workspaceDataRouter.get('/workspaces/:workspaceId/datasets', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    await member(id, req.authUser?.sub);
    res.json({ datasets: await workspaceDataService.listDatasets(id) });
  } catch (e) {
    next(e);
  }
});
workspaceDataRouter.post('/workspaces/:workspaceId/datasets', async (req, res, next) => {
  try {
    const id = workspaceIdSchema.parse(req.params.workspaceId);
    const datasetName = name.parse(req.headers['x-dataset-name']);
    const type =
      typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type']
        : 'application/octet-stream';
    await editor(id, req.authUser?.sub);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Dataset body is required.');
    res
      .status(201)
      .json({ dataset: await workspaceDataService.uploadDataset(id, datasetName, type, req.body) });
  } catch (e) {
    next(e);
  }
});
workspaceDataRouter.delete(
  '/workspaces/:workspaceId/datasets/:datasetId',
  async (req, res, next) => {
    try {
      const id = workspaceIdSchema.parse(req.params.workspaceId);
      const datasetId = z.string().cuid().parse(req.params.datasetId);
      await editor(id, req.authUser?.sub);
      await workspaceDataService.deleteDataset(id, datasetId);
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  },
);
