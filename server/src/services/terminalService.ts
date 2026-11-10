import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import Docker from 'dockerode';
import { z } from 'zod';

import { HttpError } from '../errors/httpError.js';
import { runtimeService } from './runtimeService.js';
import { workspaceService } from './workspaceService.js';
import { createDockerClient } from './dockerClient.js';

const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 8 * 1024;

const taskConfigSchema = z.object({
  run: z.array(z.string().min(1).max(256)).min(1).max(16).optional(),
  test: z.array(z.string().min(1).max(256)).min(1).max(16).optional(),
});

type TaskName = 'run' | 'test';
type TerminalSession = {
  exec: Docker.Exec;
  stream: NodeJS.ReadWriteStream;
  output: string;
};
type TaskSummary = { run: boolean; test: boolean };

/** Keeps terminal I/O inside the already-isolated workspace container. */
export class TerminalService {
  private readonly docker = createDockerClient();
  private readonly sessions = new Map<string, TerminalSession>();
  private outputListener: ((workspaceId: string, output: string) => void) | undefined;

  setOutputListener(listener: (workspaceId: string, output: string) => void): void {
    this.outputListener = listener;
  }

  async attach(workspaceId: string): Promise<{ output: string; tasks: TaskSummary }> {
    const current = this.sessions.get(workspaceId);
    if (current) {
      runtimeService.touch(workspaceId);
      return { output: current.output, tasks: await this.getTaskSummary(workspaceId) };
    }

    const containerId = await runtimeService.getRunningContainerId(workspaceId);
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: ['/bin/sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/workspace',
      Env: this.runtimeEnvironment(),
    });
    const stream = (await exec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    })) as unknown as NodeJS.ReadWriteStream;
    const session: TerminalSession = { exec, stream, output: '' };
    this.sessions.set(workspaceId, session);
    stream.on('data', (chunk: Buffer) => this.recordOutput(workspaceId, chunk.toString('utf8')));
    stream.on('close', () => this.sessions.delete(workspaceId));
    stream.on('error', () => this.sessions.delete(workspaceId));
    this.recordOutput(
      workspaceId,
      '\u001b[1;33mTogether shared terminal — commands run only inside this workspace container.\u001b[0m\r\n',
    );
    return { output: session.output, tasks: await this.getTaskSummary(workspaceId) };
  }

  write(workspaceId: string, input: string): void {
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      throw new HttpError(400, 'Terminal input is too large.');
    }
    const session = this.sessions.get(workspaceId);
    if (!session) throw new HttpError(409, 'The shared terminal is still starting.');
    session.stream.write(input);
    runtimeService.touch(workspaceId);
  }

  resize(workspaceId: string, columns: number, rows: number): void {
    const session = this.sessions.get(workspaceId);
    if (!session) return;
    // Docker's resize API is intentionally best-effort; terminal I/O still works if it fails.
    void session.exec.resize({ h: rows, w: columns });
    runtimeService.touch(workspaceId);
  }

  async runTask(workspaceId: string, task: TaskName, username: string): Promise<void> {
    const command = await this.getTaskCommand(workspaceId, task);
    if (!command) {
      throw new HttpError(
        422,
        `No ${task} command was detected. Add it to package.json or together.json.`,
      );
    }
    const containerId = await runtimeService.getRunningContainerId(workspaceId);
    this.recordOutput(
      workspaceId,
      `\r\n\u001b[1;36m${username} ran: ${command.join(' ')}\u001b[0m\r\n`,
    );
    const exec = await this.docker.getContainer(containerId).exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/workspace',
      Env: this.runtimeEnvironment(),
    });
    const stream = await exec.start({ hijack: true, stdin: false, Tty: true });
    stream.on('data', (chunk: Buffer) => this.recordOutput(workspaceId, chunk.toString('utf8')));
    stream.on('end', async () => {
      const result = await exec.inspect();
      this.recordOutput(
        workspaceId,
        `\r\n\u001b[${result.ExitCode === 0 ? '32' : '31'}mProcess exited with code ${result.ExitCode}.\u001b[0m\r\n`,
      );
    });
    runtimeService.touch(workspaceId);
  }

  private recordOutput(workspaceId: string, output: string): void {
    const session = this.sessions.get(workspaceId);
    if (session) {
      session.output = `${session.output}${output}`.slice(-MAX_BUFFER_BYTES);
    }
    this.outputListener?.(workspaceId, output);
  }

  private runtimeEnvironment(): string[] {
    return [
      'HOME=/tmp',
      'NPM_CONFIG_CACHE=/npm-cache',
      'PIP_CACHE_DIR=/pip-cache',
      'PYTHONPATH=/dependencies/python',
    ];
  }

  private async getTaskSummary(workspaceId: string): Promise<TaskSummary> {
    return {
      run: (await this.getTaskCommand(workspaceId, 'run')) !== null,
      test: (await this.getTaskCommand(workspaceId, 'test')) !== null,
    };
  }

  private async getTaskCommand(workspaceId: string, task: TaskName): Promise<string[] | null> {
    const root = workspaceService.getRoot(workspaceId);
    try {
      const configured = taskConfigSchema.parse(
        JSON.parse(await readFile(resolve(root, 'together.json'), 'utf8')),
      );
      if (configured[task]) return configured[task];
    } catch {
      // together.json is optional; use safe, detected package scripts below.
    }
    try {
      const packageJson = z
        .object({ scripts: z.record(z.string()).optional() })
        .parse(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')));
      if (task === 'test' && packageJson.scripts?.test) return ['npm', 'test'];
      const runScript = packageJson.scripts?.dev
        ? 'dev'
        : packageJson.scripts?.start
          ? 'start'
          : null;
      if (task === 'run' && runScript) return ['npm', 'run', runScript];
    } catch {
      // No Node task is available.
    }
    return null;
  }
}

export const terminalService = new TerminalService();
