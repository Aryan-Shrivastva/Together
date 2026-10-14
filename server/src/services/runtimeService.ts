import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import Docker from 'dockerode';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { workspaceService } from './workspaceService.js';

const RUNTIME_LABEL = 'together.runtime';
const RUNTIME_NETWORK_LABEL = 'together.runtime-network';

type DependencyPlan = {
  fingerprint: string;
  kind: 'node' | 'python-requirements' | 'python-project';
  command: string[];
};

function isDockerNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
}

function runtimeName(workspaceId: string): string {
  return `together-runtime-${workspaceId}`;
}

function networkName(workspaceId: string): string {
  return `together-runtime-network-${workspaceId}`;
}

function nodeModulesVolumeName(workspaceId: string): string {
  return `together-runtime-node-modules-${workspaceId}`;
}

function pythonDependenciesVolumeName(workspaceId: string): string {
  return `together-runtime-python-${workspaceId}`;
}

export class RuntimeService {
  private readonly docker = new Docker({ socketPath: '/var/run/docker.sock' });
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  async resumeIdleTimers(): Promise<void> {
    const runtimes = await prisma.workspaceRuntime.findMany({
      where: { status: 'RUNNING' },
      select: { workspaceId: true },
    });
    runtimes.forEach(({ workspaceId }) => this.scheduleIdleStop(workspaceId));
  }

  async getStatus(workspaceId: string) {
    const runtime = await prisma.workspaceRuntime.findUnique({ where: { workspaceId } });
    if (!runtime) {
      return { status: 'STOPPED' as const, dependencies: 'not detected' };
    }

    return {
      status: runtime.status,
      dependencies: runtime.dependencyFingerprint ? 'installed' : 'not installed',
      error: runtime.lastError ?? undefined,
    };
  }

  async start(workspaceId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'READY') {
      throw new HttpError(409, 'The workspace must finish cloning before its runtime can start.');
    }

    const runtime = await prisma.workspaceRuntime.upsert({
      where: { workspaceId },
      create: { workspaceId, status: 'STARTING' },
      update: { status: 'STARTING', lastError: null },
    });

    try {
      const existing = await this.findExistingContainer(
        runtime.dockerContainerId ?? runtimeName(workspaceId),
      );
      if (existing) {
        const details = await existing.inspect();
        if (!details.State.Running) {
          await existing.start();
        }
        this.scheduleIdleStop(workspaceId);
        await prisma.workspaceRuntime.update({
          where: { workspaceId },
          data: { dockerContainerId: existing.id, status: 'RUNNING', lastError: null },
        });
        return this.getStatus(workspaceId);
      }

      const network = await this.ensureNetwork(workspaceId, runtime.dockerNetworkId);
      const sourcePath = await this.workspaceVolumePath(workspaceId);
      const container = await this.docker.createContainer({
        name: runtimeName(workspaceId),
        Image: env.WORKSPACE_RUNTIME_IMAGE,
        WorkingDir: '/workspace',
        Labels: { [RUNTIME_LABEL]: workspaceId },
        HostConfig: {
          Binds: [
            `${sourcePath}:/workspace:rw`,
            `${nodeModulesVolumeName(workspaceId)}:/workspace/node_modules:rw`,
            `${pythonDependenciesVolumeName(workspaceId)}:/dependencies:rw`,
          ],
          NetworkMode: networkName(workspaceId),
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

      await prisma.workspaceRuntime.update({
        where: { workspaceId },
        data: {
          dockerContainerId: container.id,
          dockerNetworkId: network.id,
          status: 'RUNNING',
          startedAt: new Date(),
          dependencyFingerprint: null,
          lastError: null,
        },
      });
      this.scheduleIdleStop(workspaceId);
      return this.getStatus(workspaceId);
    } catch (error) {
      console.error('Workspace runtime failed to start.', {
        workspaceId,
        name: error instanceof Error ? error.name : typeof error,
        code:
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined,
      });
      await prisma.workspaceRuntime.update({
        where: { workspaceId },
        data: { status: 'ERROR', lastError: 'The workspace runtime could not start.' },
      });
      throw new HttpError(503, 'The workspace runtime could not start. Try again in a moment.');
    }
  }

  async installDependencies(workspaceId: string) {
    const plan = await this.detectDependencies(workspaceId);
    if (!plan) {
      return {
        installed: false,
        message: 'No package.json, requirements.txt, or pyproject.toml was found.',
      };
    }

    const runtime = await this.start(workspaceId);
    const record = await prisma.workspaceRuntime.findUnique({ where: { workspaceId } });
    if (!record?.dockerContainerId || runtime.status !== 'RUNNING') {
      throw new HttpError(503, 'The workspace runtime is not available.');
    }

    if (record.dependencyFingerprint === plan.fingerprint) {
      this.scheduleIdleStop(workspaceId);
      return {
        installed: false,
        message: 'Dependencies are already installed for the current workspace files.',
      };
    }

    try {
      await this.runCommand(record.dockerContainerId, plan.command);
      await prisma.workspaceRuntime.update({
        where: { workspaceId },
        data: { dependencyFingerprint: plan.fingerprint, lastError: null, status: 'RUNNING' },
      });
      this.scheduleIdleStop(workspaceId);
      return { installed: true, message: 'Dependencies installed in the shared runtime.' };
    } catch {
      console.error('Workspace dependency installation failed.', { workspaceId, kind: plan.kind });
      await prisma.workspaceRuntime.update({
        where: { workspaceId },
        data: {
          status: 'RUNNING',
          lastError: 'Dependency installation failed. Check the workspace files and retry.',
        },
      });
      throw new HttpError(
        422,
        'Dependency installation failed. Check the workspace files and retry.',
      );
    }
  }

  private async findExistingContainer(
    containerReference: string,
  ): Promise<Docker.Container | null> {
    try {
      const container = this.docker.getContainer(containerReference);
      await container.inspect();
      return container;
    } catch (error) {
      if (isDockerNotFound(error)) return null;
      throw error;
    }
  }

  private async ensureNetwork(workspaceId: string, networkId: string | null) {
    if (networkId) {
      try {
        const existing = await this.docker.getNetwork(networkId).inspect();
        return { id: existing.Id };
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }

    try {
      const existing = await this.docker.getNetwork(networkName(workspaceId)).inspect();
      return { id: existing.Id };
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }

    return this.docker.createNetwork({
      Name: networkName(workspaceId),
      Driver: 'bridge',
      Internal: false,
      Labels: { [RUNTIME_NETWORK_LABEL]: workspaceId },
    });
  }

  private async workspaceVolumePath(workspaceId: string): Promise<string> {
    const volume = await this.docker.getVolume(env.WORKSPACE_VOLUME_NAME).inspect();
    const volumeRoot = resolve(volume.Mountpoint);
    const workspacePath = resolve(volumeRoot, workspaceId);
    if (dirname(workspacePath) !== volumeRoot) {
      throw new HttpError(400, 'Invalid workspace runtime path.');
    }
    return workspacePath;
  }

  private async runCommand(containerId: string, command: string[]): Promise<void> {
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace',
      Env: [
        'HOME=/tmp',
        'NPM_CONFIG_CACHE=/tmp/.npm',
        'PIP_CACHE_DIR=/tmp/.pip',
        'PYTHONPATH=/dependencies/python',
      ],
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    stream.resume();
    await once(stream, 'end');
    const result = await exec.inspect();
    if (result.ExitCode !== 0) {
      throw new Error('Workspace command failed.');
    }
  }

  private async detectDependencies(workspaceId: string): Promise<DependencyPlan | null> {
    const root = workspaceService.getRoot(workspaceId);
    const files = ['package.json', 'package-lock.json', 'requirements.txt', 'pyproject.toml'];
    const content = await Promise.all(
      files.map(async (file) => {
        try {
          return [file, await readFile(resolve(root, file), 'utf8')] as const;
        } catch {
          return null;
        }
      }),
    );
    const found = new Map<string, string>();
    content.forEach((entry) => {
      if (entry) {
        found.set(entry[0], entry[1]);
      }
    });
    if (found.has('package.json')) {
      return {
        kind: 'node',
        command: found.has('package-lock.json') ? ['npm', 'ci'] : ['npm', 'install'],
        fingerprint: this.fingerprint(found),
      };
    }
    if (found.has('requirements.txt')) {
      return {
        kind: 'python-requirements',
        command: [
          'python3',
          '-m',
          'pip',
          'install',
          '--target',
          '/dependencies/python',
          '-r',
          'requirements.txt',
        ],
        fingerprint: this.fingerprint(found),
      };
    }
    if (found.has('pyproject.toml')) {
      return {
        kind: 'python-project',
        command: ['python3', '-m', 'pip', 'install', '--target', '/dependencies/python', '.'],
        fingerprint: this.fingerprint(found),
      };
    }
    return null;
  }

  private fingerprint(files: Map<string, string>): string {
    const hash = createHash('sha256');
    [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([name, content]) => hash.update(name).update(content));
    return hash.digest('hex');
  }

  private scheduleIdleStop(workspaceId: string): void {
    const current = this.idleTimers.get(workspaceId);
    if (current) clearTimeout(current);
    this.idleTimers.set(
      workspaceId,
      setTimeout(() => void this.stopForIdle(workspaceId), env.WORKSPACE_RUNTIME_IDLE_MS),
    );
  }

  private async stopForIdle(workspaceId: string): Promise<void> {
    this.idleTimers.delete(workspaceId);
    const runtime = await prisma.workspaceRuntime.findUnique({ where: { workspaceId } });
    if (!runtime?.dockerContainerId) return;
    try {
      await this.docker.getContainer(runtime.dockerContainerId).stop({ t: 10 });
    } catch (error) {
      if (
        !isDockerNotFound(error) &&
        !(
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          error.statusCode === 304
        )
      ) {
        console.error('Workspace runtime failed to stop after idle timeout.', { workspaceId });
        return;
      }
    }
    await prisma.workspaceRuntime.update({
      where: { workspaceId },
      data: { status: 'STOPPED' },
    });
  }
}

export const runtimeService = new RuntimeService();
