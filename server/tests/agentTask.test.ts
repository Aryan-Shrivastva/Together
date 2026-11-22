import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../src/db/client.js';
import { agentTaskService } from '../src/services/agentTaskService.js';
import { branchService } from '../src/services/branchService.js';
import { collaborationService } from '../src/services/collaborationService.js';
import { fileService } from '../src/services/fileService.js';
import { gitService } from '../src/services/gitService.js';
import { runtimeService } from '../src/services/runtimeService.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { HttpError } from '../src/errors/httpError.js';

test('agent creates a branch, changes multiple files, commits and reports real check failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'together-agent-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/app.ts'), 'old');
  const restore: Array<() => void> = [];
  const replace = (obj: object, key: string, value: unknown) => {
    const x = obj as Record<string, unknown>;
    const before = x[key];
    x[key] = value;
    restore.push(() => {
      x[key] = before;
    });
  };
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test';
  const updates: Array<Record<string, unknown>> = [];
  let commitFiles: string[] = [];
  replace(prisma.agentTask, 'update', async ({ data }: { data: Record<string, unknown> }) => {
    updates.push(data);
  });
  replace(branchService, 'create', async () => ({
    id: 'branch',
    name: 'task',
    branchWorkspaceId: 'branch-workspace',
  }));
  replace(collaborationService, 'flushWorkspace', async () => {});
  replace(workspaceService, 'getRoot', () => root);
  replace(workspaceService, 'resolveFilePath', async (_id: string, path: string) =>
    join(root, path),
  );
  replace(fileService, 'readTextFile', async (_id: string, path: string) => {
    if (path === 'package.json') return { path, content: '{"scripts":{"test":"test"}}' };
    try {
      return { path, content: await readFile(join(root, path), 'utf8') };
    } catch {
      throw new HttpError(404, 'Not found');
    }
  });
  replace(fileService, 'writeTextFile', async (_id: string, path: string, content: string) => {
    if (path === 'src/new.ts') throw new HttpError(404, 'Not found');
    await writeFile(join(root, path), content);
  });
  replace(fileService, 'create', async (_id: string, input: { path: string; content: string }) =>
    writeFile(join(root, input.path), input.content),
  );
  replace(
    gitService,
    'commit',
    async (_id: string, _user: string, _message: string, files: string[]) => {
      commitFiles = files;
    },
  );
  replace(runtimeService, 'runWorkspaceCommand', async () => ({
    exitCode: 1,
    logTail: 'test failed',
  }));
  let calls = 0;
  replace(globalThis, 'fetch', async () => {
    const value =
      ++calls === 1
        ? { summary: 'plan', files: ['src/app.ts'] }
        : {
            summary: 'done',
            files: [
              { path: 'src/app.ts', content: 'updated' },
              { path: 'src/new.ts', content: 'new' },
            ],
          };
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
        ],
      }),
    );
  });
  try {
    await agentTaskService.run('id', 'main', 'user', 'alice', 'Implement feature');
    assert.deepEqual(commitFiles, ['src/app.ts', 'src/new.ts']);
    assert.equal(await readFile(join(root, 'src/app.ts'), 'utf8'), 'updated');
    assert.equal(await readFile(join(root, 'src/new.ts'), 'utf8'), 'new');
    assert.match(String(updates.at(-1)?.result), /npm run test: FAILED/);
    assert.match(String(updates.at(-1)?.result), /not been merged or pushed/);
  } finally {
    restore.reverse().forEach((fn) => fn());
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  }
});
