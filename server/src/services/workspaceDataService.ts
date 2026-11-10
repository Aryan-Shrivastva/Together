import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Client } from 'minio';

import { encryptGitHubToken } from '../auth/crypto.js';
import { env, getAuthenticationConfig } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { workspaceService } from './workspaceService.js';

const minio = new Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY ?? '',
  secretKey: env.MINIO_SECRET_KEY ?? '',
});

export class WorkspaceDataService {
  async listConfig(workspaceId: string) {
    return prisma.workspaceConfig.findMany({
      where: { workspaceId },
      select: { key: true, updatedAt: true },
      orderBy: { key: 'asc' },
    });
  }

  async setConfig(workspaceId: string, key: string, value: string) {
    const encryptionKey = getAuthenticationConfig().TOKEN_ENCRYPTION_KEY;
    await prisma.workspaceConfig.upsert({
      where: { workspaceId_key: { workspaceId, key } },
      create: { workspaceId, key, encryptedValue: encryptGitHubToken(value, encryptionKey) },
      update: { encryptedValue: encryptGitHubToken(value, encryptionKey) },
    });
  }

  async deleteConfig(workspaceId: string, key: string) {
    await prisma.workspaceConfig.deleteMany({ where: { workspaceId, key } });
  }

  async listDatasets(workspaceId: string) {
    return prisma.dataset.findMany({
      where: { workspaceId },
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async uploadDataset(workspaceId: string, name: string, contentType: string, body: Buffer) {
    if (body.length > env.MAX_DATASET_BYTES)
      throw new HttpError(413, 'Dataset exceeds the upload limit.');
    const objectKey = `${workspaceId}/${randomUUID()}`;
    await this.ensureBucket();
    await minio.putObject(env.MINIO_BUCKET, objectKey, Readable.from(body), body.length, {
      'Content-Type': contentType,
      'X-Amz-Meta-Original-Name': name,
    });
    const dataset = await prisma.dataset.create({
      data: { workspaceId, objectKey, originalName: name, contentType, sizeBytes: body.length },
    });
    await this.syncDataset(dataset);
    return dataset;
  }

  async deleteDataset(workspaceId: string, datasetId: string) {
    const dataset = await prisma.dataset.findFirst({ where: { id: datasetId, workspaceId } });
    if (!dataset) throw new HttpError(404, 'Dataset not found.');
    await minio.removeObject(env.MINIO_BUCKET, dataset.objectKey);
    await prisma.dataset.delete({ where: { id: dataset.id } });
    await rm(join(this.datasetDirectory(workspaceId), dataset.id), { force: true });
  }

  async syncWorkspaceDatasets(workspaceId: string): Promise<string> {
    const datasets = await prisma.dataset.findMany({ where: { workspaceId } });
    await mkdir(this.datasetDirectory(workspaceId), { recursive: true });
    await Promise.all(datasets.map((dataset) => this.syncDataset(dataset)));
    return this.datasetDirectory(workspaceId);
  }

  private datasetDirectory(workspaceId: string): string {
    return join(workspaceService.getRoot(workspaceId), '.together', 'datasets');
  }

  private async syncDataset(dataset: { id: string; workspaceId: string; objectKey: string }) {
    const directory = this.datasetDirectory(dataset.workspaceId);
    await mkdir(directory, { recursive: true });
    await pipeline(
      await minio.getObject(env.MINIO_BUCKET, dataset.objectKey),
      createWriteStream(join(directory, dataset.id)),
    );
  }

  private async ensureBucket() {
    if (!(await minio.bucketExists(env.MINIO_BUCKET))) await minio.makeBucket(env.MINIO_BUCKET);
  }
}

export const workspaceDataService = new WorkspaceDataService();
