import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import { assistantService } from '../src/services/assistantService.js';
import { collaborationService } from '../src/services/collaborationService.js';
import { fileService } from '../src/services/fileService.js';
import { runtimeService } from '../src/services/runtimeService.js';

const originalKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
const replace = (object: object, key: string, value: unknown) => {
  const record = object as Record<string, unknown>;
  const old = record[key];
  record[key] = value;
  return () => {
    record[key] = old;
  };
};

test('assistant scopes context, rejects secrets, persists answers, and checks branch test ownership', async () => {
  process.env.OPENAI_API_KEY = 'test-only';
  let captured = '';
  const restore = [
    replace(collaborationService, 'flushWorkspace', async () => {}),
    replace(prisma.chatMessage, 'findMany', async (args: { where: { workspaceId: string } }) => {
      assert.equal(args.where.workspaceId, 'workspace-a');
      return [{ content: 'Feature review in progress', user: { username: 'alice' } }];
    }),
    replace(prisma.activityLog, 'findMany', async () => []),
    replace(prisma.assistantMessage, 'findMany', async () => []),
    replace(prisma.branch, 'findMany', async () => []),
    replace(prisma.assistantMessage, 'create', async (args: { data: object }) => args.data),
    replace(prisma.branch, 'findFirst', async (args: { where: { workspaceId: string } }) => {
      assert.equal(args.where.workspaceId, 'workspace-a');
      return null;
    }),
    replace(fileService, 'readTextFile', async (id: string, path: string) => {
      assert.equal(id, 'workspace-a');
      assert.equal(path, 'README.md');
      return { path, content: 'A collaborative coding workspace.' };
    }),
    replace(runtimeService, 'runWorkspaceCommand', async () => {
      throw new Error('Other workspace must not run');
    }),
  ];
  globalThis.fetch = async (_input, init) => {
    captured = String(init?.body);
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Alice is reviewing the feature.' }],
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const answer = await assistantService.ask('workspace-a', 'user-a', 'What is Alice doing?');
    assert.equal(answer.answer, 'Alice is reviewing the feature.');
    assert.equal(answer.workspaceId, 'workspace-a');
    assert.match(captured, /Feature review in progress/);
    assert.equal(JSON.parse(captured).store, false);
    await assert.rejects(() => assistantService.ask('workspace-a', 'user-a', 'Read this', '.env'));
    await assert.rejects(() =>
      assistantService.runTests('workspace-a', 'user-a', 'foreign-branch'),
    );
  } finally {
    restore.reverse().forEach((fn) => fn());
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await prisma.$disconnect();
  }
});

test('assistant creates a reviewable branch edit and reports actual test output', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { branchService } = await import('../src/services/branchService.js');
  const { gitService } = await import('../src/services/gitService.js');
  const { workspaceService } = await import('../src/services/workspaceService.js');
  const { membershipService } = await import('../src/services/membershipService.js');
  const root = await mkdtemp(join(tmpdir(), 'together-ai-test-'));
  const branchRoot = await mkdtemp(join(tmpdir(), 'together-ai-branch-'));
  const path = 'feature.ts';
  const before = 'export const value = 1;\n';
  await writeFile(join(root, path), before);
  await writeFile(join(branchRoot, path), before);
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'add',
    path,
  ]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  process.env.OPENAI_API_KEY = 'test-only';
  let committed = false;
  const restore = [
    replace(collaborationService, 'flushWorkspace', async () => {}),
    replace(prisma.chatMessage, 'findMany', async () => []),
    replace(prisma.activityLog, 'findMany', async () => []),
    replace(prisma.assistantMessage, 'findMany', async () => []),
    replace(prisma.branch, 'findMany', async () => []),
    replace(prisma.user, 'findUnique', async () => ({ username: 'alice' })),
    replace(prisma.workspace, 'findUnique', async () => ({ defaultBranch: 'main' })),
    replace(prisma.assistantMessage, 'create', async (args: { data: object }) => args.data),
    replace(prisma.branch, 'findFirst', async () => ({
      name: 'task',
      branchWorkspaceId: 'branch',
    })),
    replace(branchService, 'create', async () => ({ name: 'task', branchWorkspaceId: 'branch' })),
    replace(workspaceService, 'getRoot', () => root),
    replace(workspaceService, 'resolveFilePath', async (_id: string, file: string) =>
      join(branchRoot, file),
    ),
    replace(fileService, 'readTextFile', async (_id: string, file: string) =>
      file === 'package.json'
        ? { path: file, content: '{"scripts":{"test":"test command"}}' }
        : { path: file, content: before },
    ),
    replace(
      gitService,
      'commit',
      async (_workspace: string, _user: string, _message: string, files: string[]) => {
        assert.deepEqual(files, [path]);
        committed = true;
      },
    ),
    replace(membershipService, 'requireEditor', async () => ({ role: 'OWNER' })),
    replace(
      runtimeService,
      'runWorkspaceCommand',
      async (_workspace: string, command: string[]) => {
        assert.deepEqual(command, ['npm', 'test']);
        return { exitCode: 1, logTail: 'test failed' };
      },
    ),
  ];
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'export const value = 2;' }] },
        ],
      }),
      { status: 200 },
    );
  try {
    const answer = await assistantService.ask('workspace-a', 'user-a', 'Update value', path, true);
    assert.match(answer.answer, /task branch/);
    assert.equal(await readFile(join(root, path), 'utf8'), before);
    assert.equal(await readFile(join(branchRoot, path), 'utf8'), 'export const value = 2;');
    assert.equal(committed, true);
    const result = await assistantService.runTests('workspace-a', 'user-a', 'branch-id');
    assert.match(result.answer, /FAILED \(exit 1\)/);
    assert.match(result.answer, /test failed/);
  } finally {
    restore.reverse().forEach((fn) => fn());
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
    await rm(branchRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  }
});
