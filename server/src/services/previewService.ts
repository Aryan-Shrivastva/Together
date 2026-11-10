import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import Docker from 'dockerode';
import { z } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { workspaceService } from './workspaceService.js';
import { workspaceDataService } from './workspaceDataService.js';
import { createDockerClient } from './dockerClient.js';

const PREVIEW_LABEL = 'together.preview';
const PREVIEW_NETWORK_LABEL = 'together.preview-network';
const previewConfigurationSchema = z
  .object({
    preview: z
      .object({
        command: z
          .array(
            z
              .string()
              .min(1)
              .max(200)
              .refine((value) => !value.includes('\0')),
          )
          .min(1)
          .max(16),
        port: z.number().int().min(1024).max(65535),
      })
      .strict(),
  })
  .strict();

type PreviewPlan = { command: string[]; port: number };

function isDockerNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
}

function isDockerNotModified(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 304
  );
}

function previewContainerName(previewId: string): string {
  return `together-preview-${previewId}`;
}

function previewNetworkName(previewId: string): string {
  return `together-preview-network-${previewId}`;
}

function previewHostName(previewId: string): string {
  return `together-preview-${previewId}`;
}

function volumeName(kind: string, workspaceId: string): string {
  return `together-runtime-${kind}-${workspaceId}`;
}

export class PreviewService {
  private readonly docker = createDockerClient();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  async resumeIdleTimers(): Promise<void> {
    const previews = await prisma.preview.findMany({
      where: { status: 'RUNNING' },
      select: { id: true },
    });
    previews.forEach(({ id }) => this.scheduleIdleStop(id));
  }

  async launch(workspaceId: string) {
    await this.assertBranchWorkspace(workspaceId);
    const preview = await prisma.preview.upsert({
      where: { workspaceId },
      create: { workspaceId, port: 5173, status: 'STARTING' },
      update: { status: 'STARTING', lastError: null },
    });
    const plan = await this.detectPlan(workspaceId, preview.id);
    await prisma.preview.update({ where: { id: preview.id }, data: { port: plan.port } });

    try {
      const existing = await this.findContainer(
        preview.dockerContainerId ?? previewContainerName(preview.id),
      );
      if (existing) {
        const details = await existing.inspect();
        if (!details.State.Running) await existing.start();
        await this.connectServer(preview.id, preview.dockerNetworkId);
        await prisma.preview.update({
          where: { id: preview.id },
          data: { dockerContainerId: existing.id, status: 'RUNNING', lastError: null },
        });
      } else {
        const network = await this.ensureNetwork(preview.id, preview.dockerNetworkId);
        await prisma.preview.update({
          where: { id: preview.id },
          data: { dockerNetworkId: network.id },
        });
        await this.connectServer(preview.id, network.id);
        const sourcePath = await this.workspaceVolumePath(workspaceId);
        const datasetsPath = await workspaceDataService.syncWorkspaceDatasets(workspaceId);
        const container = await this.docker.createContainer({
          name: previewContainerName(preview.id),
          Image: env.WORKSPACE_RUNTIME_IMAGE,
          Cmd: plan.command,
          WorkingDir: '/workspace',
          Env: [
            'HOME=/tmp',
            'NPM_CONFIG_CACHE=/npm-cache',
            'PIP_CACHE_DIR=/pip-cache',
            'PYTHONPATH=/dependencies/python',
            `PORT=${plan.port}`,
          ],
          Labels: { [PREVIEW_LABEL]: preview.id },
          HostConfig: {
            Binds: [
              `${sourcePath}:/workspace:rw`,
              `${volumeName('node-modules', workspaceId)}:/workspace/node_modules:rw`,
              `${volumeName('python', workspaceId)}:/dependencies:rw`,
              `${volumeName('npm-cache', workspaceId)}:/npm-cache:rw`,
              `${volumeName('pip-cache', workspaceId)}:/pip-cache:rw`,
              `${datasetsPath}:/datasets:ro`,
            ],
            NetworkMode: previewNetworkName(preview.id),
            Memory: env.WORKSPACE_RUNTIME_MEMORY_MB * 1024 * 1024,
            NanoCpus: Math.round(env.WORKSPACE_RUNTIME_CPU_COUNT * 1_000_000_000),
            PidsLimit: env.WORKSPACE_RUNTIME_PIDS_LIMIT,
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777' },
          },
        });
        await container.start();
        const details = await container.inspect();
        if (!details.State.Running) {
          throw new Error('Preview command exited immediately.');
        }
        await prisma.preview.update({
          where: { id: preview.id },
          data: {
            dockerContainerId: container.id,
            dockerNetworkId: network.id,
            status: 'RUNNING',
            startedAt: new Date(),
            lastError: null,
          },
        });
      }
      this.scheduleIdleStop(preview.id);
      return this.get(workspaceId);
    } catch (error) {
      console.error('Preview failed to start.', {
        workspaceId,
        name: error instanceof Error ? error.name : typeof error,
      });
      await prisma.preview.update({
        where: { id: preview.id },
        data: { status: 'ERROR', lastError: 'The preview could not start.' },
      });
      throw new HttpError(
        503,
        'The preview could not start. Check its dependencies and try again.',
      );
    }
  }

  async get(workspaceId: string) {
    const preview = await prisma.preview.findUnique({ where: { workspaceId } });
    if (!preview) return { status: 'STOPPED' as const };
    return {
      id: preview.id,
      status: preview.status,
      url: preview.status === 'RUNNING' ? `/preview/${preview.id}/` : undefined,
      error: preview.lastError ?? undefined,
    };
  }

  async stop(workspaceId: string) {
    const preview = await prisma.preview.findUnique({ where: { workspaceId } });
    if (!preview) return this.get(workspaceId);
    this.clearIdleTimer(preview.id);
    if (preview.dockerContainerId) {
      const container = this.docker.getContainer(preview.dockerContainerId);
      try {
        await container.stop({ t: 10 });
      } catch (error) {
        if (!isDockerNotFound(error) && !isDockerNotModified(error)) {
          throw new HttpError(503, 'The preview could not stop. Try again in a moment.');
        }
      }
      try {
        await container.remove({ force: true });
      } catch (error) {
        if (!isDockerNotFound(error)) {
          throw new HttpError(
            503,
            'The preview container could not be removed. Try again in a moment.',
          );
        }
      }
    }
    await this.disconnectServer(preview.id, preview.dockerNetworkId);
    if (preview.dockerNetworkId) {
      try {
        await this.docker.getNetwork(preview.dockerNetworkId).remove();
      } catch (error) {
        if (!isDockerNotFound(error)) {
          throw new HttpError(
            503,
            'The preview network could not be removed. Try again in a moment.',
          );
        }
      }
    }
    await prisma.preview.update({
      where: { id: preview.id },
      data: {
        status: 'STOPPED',
        dockerContainerId: null,
        dockerNetworkId: null,
        lastError: null,
      },
    });
    return this.get(workspaceId);
  }

  async resolveProxy(previewId: string) {
    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      select: { id: true, workspaceId: true, port: true, status: true },
    });
    if (!preview || preview.status !== 'RUNNING') {
      throw new HttpError(404, 'This preview is not running.');
    }
    this.scheduleIdleStop(preview.id);
    return {
      workspaceId: preview.workspaceId,
      host: previewHostName(preview.id),
      port: preview.port,
    };
  }

  private async assertBranchWorkspace(workspaceId: string) {
    const branch = await prisma.branch.findUnique({ where: { branchWorkspaceId: workspaceId } });
    if (!branch)
      throw new HttpError(409, 'Previews are available only for a temporary task branch.');
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true },
    });
    if (!workspace || workspace.status !== 'READY')
      throw new HttpError(409, 'The branch workspace is not ready.');
  }

  private async detectPlan(workspaceId: string, previewId: string): Promise<PreviewPlan> {
    const root = workspaceService.getRoot(workspaceId);
    try {
      const configuration = JSON.parse(await readFile(resolve(root, 'together.json'), 'utf8'));
      const parsed = previewConfigurationSchema.safeParse(configuration);
      if (parsed.success) return parsed.data.preview;
      throw new HttpError(422, 'together.json preview configuration is invalid.');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new HttpError(422, 'together.json preview configuration is invalid.');
      }
    }
    try {
      await readFile(resolve(root, 'package.json'));
      return {
        command: [
          'npm',
          'run',
          'dev',
          '--',
          '--host',
          '0.0.0.0',
          '--base',
          `/preview/${previewId}/`,
        ],
        port: 5173,
      };
    } catch {
      return { command: ['python3', '-m', 'http.server', '8000', '--bind', '0.0.0.0'], port: 8000 };
    }
  }

  private async findContainer(reference: string): Promise<Docker.Container | null> {
    try {
      const container = this.docker.getContainer(reference);
      await container.inspect();
      return container;
    } catch (error) {
      if (isDockerNotFound(error)) return null;
      throw error;
    }
  }

  private async ensureNetwork(previewId: string, networkId: string | null) {
    if (networkId) {
      try {
        const network = await this.docker.getNetwork(networkId).inspect();
        return { id: network.Id };
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }
    try {
      const network = await this.docker.getNetwork(previewNetworkName(previewId)).inspect();
      return { id: network.Id };
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }
    return this.docker.createNetwork({
      Name: previewNetworkName(previewId),
      Driver: 'bridge',
      Internal: true,
      Labels: { [PREVIEW_NETWORK_LABEL]: previewId },
    });
  }

  private async connectServer(previewId: string, networkId: string | null) {
    if (!networkId) return;
    const serverId = process.env.HOSTNAME;
    if (!serverId) throw new HttpError(503, 'The preview proxy is unavailable outside Docker.');
    try {
      await this.docker.getNetwork(networkId).connect({
        Container: serverId,
      });
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 403
      ))
        throw error;
    }
  }

  private async disconnectServer(previewId: string, networkId: string | null) {
    if (!networkId || !process.env.HOSTNAME) return;
    try {
      await this.docker
        .getNetwork(networkId)
        .disconnect({ Container: process.env.HOSTNAME, Force: true });
    } catch (error) {
      if (!isDockerNotFound(error))
        console.error('Preview proxy network disconnect failed.', { previewId });
    }
  }

  private async workspaceVolumePath(workspaceId: string): Promise<string> {
    const volume = await this.docker.getVolume(env.WORKSPACE_VOLUME_NAME).inspect();
    const volumeRoot = resolve(volume.Mountpoint);
    const workspacePath = resolve(volumeRoot, workspaceId);
    if (dirname(workspacePath) !== volumeRoot)
      throw new HttpError(400, 'Invalid preview workspace path.');
    return workspacePath;
  }

  private scheduleIdleStop(previewId: string) {
    this.clearIdleTimer(previewId);
    this.idleTimers.set(
      previewId,
      setTimeout(() => void this.stopForIdle(previewId), env.PREVIEW_IDLE_MS),
    );
  }

  private clearIdleTimer(previewId: string) {
    const timer = this.idleTimers.get(previewId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(previewId);
  }

  private async stopForIdle(previewId: string) {
    this.idleTimers.delete(previewId);
    const preview = await prisma.preview.findUnique({ where: { id: previewId } });
    if (!preview) return;
    try {
      await this.stop(preview.workspaceId);
    } catch {
      console.error('Preview failed to stop after idle timeout.', { previewId });
    }
  }
}

export const previewService = new PreviewService();
