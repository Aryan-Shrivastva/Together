import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import Docker from 'dockerode';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { workspaceService } from './workspaceService.js';
import { workspaceDataService } from './workspaceDataService.js';
import { createDockerClient } from './dockerClient.js';

const RUNTIME_LABEL = 'together.runtime';
const RUNTIME_NETWORK_LABEL = 'together.runtime-network';

type DependencyPlan = {
  fingerprint: string;
  kind: 'node' | 'python-requirements' | 'python-project';
  command: string[];
  manifest: string;
  packages: DependencyPackage[];
};

export type DependencyPackage = {
  name: string;
  requested: string;
  section: 'dependencies' | 'devDependencies' | 'requirements' | 'pyproject';
};

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

function npmCacheVolumeName(workspaceId: string): string {
  return `together-runtime-npm-cache-${workspaceId}`;
}

function pipCacheVolumeName(workspaceId: string): string {
  return `together-runtime-pip-cache-${workspaceId}`;
}

export class RuntimeService {
  private readonly docker = createDockerClient();
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
    const plan = await this.detectDependencies(workspaceId);
    if (!runtime) {
      return {
        status: 'STOPPED' as const,
        dependencies: plan ? ('not installed' as const) : ('not detected' as const),
        kind: plan?.kind,
        manifest: plan?.manifest,
        packages: plan?.packages ?? [],
      };
    }

    return {
      status: runtime.status,
      dependencies: runtime.dependencyFingerprint
        ? 'installed'
        : plan
          ? 'not installed'
          : 'not detected',
      kind: plan?.kind,
      manifest: plan?.manifest,
      packages: plan?.packages ?? [],
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
      const datasetsPath = await workspaceDataService.syncWorkspaceDatasets(workspaceId);
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
            `${npmCacheVolumeName(workspaceId)}:/npm-cache:rw`,
            `${pipCacheVolumeName(workspaceId)}:/pip-cache:rw`,
            `${datasetsPath}:/datasets:ro`,
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

  async installDependencies(workspaceId: string, options: { lockfile?: boolean } = {}) {
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
        kind: plan.kind,
        manifest: plan.manifest,
        packages: plan.packages,
        durationMs: 0,
      };
    }

    const startedAt = Date.now();
    try {
      if (options.lockfile && plan.kind === 'node') {
        const lockResult = await this.runCommand(record.dockerContainerId, [
          'npm',
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ]);
        if (lockResult.exitCode !== 0) throw new Error('Lockfile generation failed.');
        const installResult = await this.runCommand(record.dockerContainerId, [
          'npm',
          'ci',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ]);
        if (installResult.exitCode !== 0) throw new Error('Dependency installation failed.');
      } else {
        const installResult = await this.runCommand(record.dockerContainerId, plan.command);
        if (installResult.exitCode !== 0) throw new Error('Dependency installation failed.');
      }
      const installedPlan = (await this.detectDependencies(workspaceId)) ?? plan;
      await prisma.workspaceRuntime.update({
        where: { workspaceId },
        data: {
          dependencyFingerprint: installedPlan.fingerprint,
          lastError: null,
          status: 'RUNNING',
        },
      });
      this.scheduleIdleStop(workspaceId);
      return {
        installed: true,
        message: 'Dependencies installed in the shared runtime.',
        kind: plan.kind,
        manifest: plan.manifest,
        packages: plan.packages,
        durationMs: Date.now() - startedAt,
      };
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

  async runWorkspaceCommand(workspaceId: string, command: string[]) {
    const runtime = await this.start(workspaceId);
    const record = await prisma.workspaceRuntime.findUnique({ where: { workspaceId } });
    if (runtime.status !== 'RUNNING' || !record?.dockerContainerId) {
      throw new HttpError(503, 'The workspace runtime is not available.');
    }
    this.scheduleIdleStop(workspaceId);
    return this.runCommand(record.dockerContainerId, command);
  }

  async verifyWorkspace(workspaceId: string) {
    const plan = await this.detectDependencies(workspaceId);
    if (!plan) {
      return { success: true, commands: [], durationSeconds: 0 };
    }
    const commands =
      plan.kind === 'node'
        ? [
            ['npm', 'run', 'build', '--if-present'],
            ['npm', 'run', 'test', '--if-present'],
            ['npm', 'run', 'typecheck', '--if-present'],
          ]
        : [['python3', '-m', 'compileall', '-q', '.']];
    const startedAt = Date.now();
    const results: Array<{ command: string; success: boolean; logTail: string }> = [];
    for (const command of commands) {
      const result = await this.runWorkspaceCommand(workspaceId, command);
      results.push({
        command: command.join(' '),
        success: result.exitCode === 0,
        logTail: result.logTail,
      });
      if (result.exitCode !== 0) break;
    }
    return {
      success: results.length === commands.length && results.every((result) => result.success),
      commands: results,
      durationSeconds: (Date.now() - startedAt) / 1_000,
    };
  }

  async getRunningContainerId(workspaceId: string): Promise<string> {
    const runtime = await this.start(workspaceId);
    const record = await prisma.workspaceRuntime.findUnique({ where: { workspaceId } });
    if (runtime.status !== 'RUNNING' || !record?.dockerContainerId) {
      throw new HttpError(503, 'The workspace runtime is not available.');
    }
    this.scheduleIdleStop(workspaceId);
    return record.dockerContainerId;
  }

  touch(workspaceId: string): void {
    this.scheduleIdleStop(workspaceId);
  }

  async stopAndCleanup(workspaceId: string): Promise<void> {
    this.clearIdleTimer(workspaceId);
    const runtime = await prisma.workspaceRuntime.findUnique({ where: { workspaceId } });
    if (!runtime) return;

    if (runtime.dockerContainerId) {
      const container = this.docker.getContainer(runtime.dockerContainerId);
      try {
        await container.stop({ t: 10 });
      } catch (error) {
        if (!isDockerNotFound(error) && !isDockerNotModified(error)) throw error;
      }
      try {
        await container.remove({ force: true });
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }

    if (runtime.dockerNetworkId) {
      try {
        await this.docker.getNetwork(runtime.dockerNetworkId).remove();
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }

    for (const volumeName of [
      nodeModulesVolumeName(workspaceId),
      pythonDependenciesVolumeName(workspaceId),
      npmCacheVolumeName(workspaceId),
      pipCacheVolumeName(workspaceId),
    ]) {
      try {
        await this.docker.getVolume(volumeName).remove({ force: true });
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }

    await prisma.workspaceRuntime.update({
      where: { workspaceId },
      data: {
        dockerContainerId: null,
        dockerNetworkId: null,
        status: 'STOPPED',
        dependencyFingerprint: null,
      },
    });
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

  private async runCommand(
    containerId: string,
    command: string[],
  ): Promise<{ exitCode: number; logTail: string }> {
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace',
      Env: [
        'HOME=/tmp',
        'NPM_CONFIG_CACHE=/npm-cache',
        'PIP_CACHE_DIR=/pip-cache',
        'PYTHONPATH=/dependencies/python',
      ],
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    let output = '';
    stream.on('data', (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-12_000);
    });
    stream.resume();
    await once(stream, 'end');
    const result = await exec.inspect();
    return { exitCode: result.ExitCode ?? 0, logTail: output };
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
      const packages = this.readNodeDependencies(found.get('package.json') ?? '');
      return {
        kind: 'node',
        command: [
          'npm',
          'install',
          '--prefer-offline',
          '--no-audit',
          '--no-fund',
          '--progress=false',
          '--no-save',
          '--package-lock=false',
        ],
        fingerprint: this.fingerprint(found),
        manifest: found.has('package-lock.json')
          ? 'package.json + package-lock.json'
          : 'package.json',
        packages,
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
          '--disable-pip-version-check',
          '--no-input',
          '--prefer-binary',
          '--target',
          '/dependencies/python',
          '-r',
          'requirements.txt',
        ],
        fingerprint: this.fingerprint(found),
        manifest: 'requirements.txt',
        packages: this.readRequirementsDependencies(found.get('requirements.txt') ?? ''),
      };
    }
    if (found.has('pyproject.toml')) {
      return {
        kind: 'python-project',
        command: [
          'python3',
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--no-input',
          '--prefer-binary',
          '--target',
          '/dependencies/python',
          '.',
        ],
        fingerprint: this.fingerprint(found),
        manifest: 'pyproject.toml',
        packages: [],
      };
    }
    return null;
  }

  private readNodeDependencies(content: string): DependencyPackage[] {
    try {
      const manifest = JSON.parse(content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return (['dependencies', 'devDependencies'] as const).flatMap((section) =>
        Object.entries(manifest[section] ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, requested]) => ({ name, requested, section })),
      );
    } catch {
      return [];
    }
  }

  private readRequirementsDependencies(content: string): DependencyPackage[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))
      .map((requested) => ({
        name: (requested.split(/[<>=!~;\s]/)[0] ?? requested).split('[')[0] ?? requested,
        requested,
        section: 'requirements' as const,
      }));
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

  private clearIdleTimer(workspaceId: string): void {
    const current = this.idleTimers.get(workspaceId);
    if (current) clearTimeout(current);
    this.idleTimers.delete(workspaceId);
  }
}

export const runtimeService = new RuntimeService();
