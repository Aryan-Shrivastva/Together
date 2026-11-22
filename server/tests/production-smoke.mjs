import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { io } from 'socket.io-client';
import { prisma } from './server/dist/db/client.js';
import { createSessionToken } from './server/dist/auth/session.js';
import { workspaceService } from './server/dist/services/workspaceService.js';
import { workspaceDataService } from './server/dist/services/workspaceDataService.js';
import { runtimeService } from './server/dist/services/runtimeService.js';

const id = randomUUID();
let user;
let teammate;
let datasetId;
const sockets = [];
function event(socket, name, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, receive);
      reject(new Error(`No ${name} received`));
    }, 10_000);
    function receive(payload) {
      if (!matches(payload)) return;
      clearTimeout(timer);
      socket.off(name, receive);
      resolve(payload);
    }
    socket.on(name, receive);
  });
}
try {
  user = await prisma.user.create({
    data: {
      githubId: `cloud-smoke-${id}`,
      username: 'cloud-smoke-test',
      avatarUrl: 'https://example.com/avatar.png',
      githubAccessTokenEncrypted: 'unused-smoke-fixture',
    },
  });
  teammate = await prisma.user.create({
    data: {
      githubId: `cloud-teammate-${id}`,
      username: 'cloud-teammate-test',
      avatarUrl: 'https://example.com/avatar.png',
      githubAccessTokenEncrypted: 'unused-smoke-fixture',
    },
  });
  await prisma.workspace.create({
    data: {
      id,
      name: 'Production smoke test',
      repoFullName: 'test/cloud-smoke',
      repoCloneUrl: 'https://github.com/test/cloud-smoke.git',
      defaultBranch: 'main',
      ownerId: user.id,
      diskPath: workspaceService.getRoot(id),
      status: 'READY',
      members: {
        create: [
          { userId: user.id, role: 'OWNER' },
          { userId: teammate.id, role: 'COLLABORATOR' },
        ],
      },
    },
  });
  const root = await workspaceService.prepareEmptyRoot(id);
  await writeFile(join(root, 'hello.txt'), 'Production filesystem works.\n');
  await promisify(execFile)('git', ['init', '-b', 'main', root]);
  const token = createSessionToken({
    sub: user.id,
    githubId: user.githubId,
    username: user.username,
  });
  const origin = process.env.SMOKE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4000';
  const base = `${origin}/api/workspaces/${id}`;
  const headers = { Cookie: `together_session=${token}` };
  assert.equal((await fetch(base + '/versions')).status, 401);
  const versions = await fetch(base + '/versions', { headers });
  assert.equal(versions.status, 200);
  assert.equal((await versions.json()).unseenCount, 0);
  const tree = await fetch(base + '/tree', { headers });
  assert.equal(tree.status, 200);
  assert((await tree.json()).tree.some((entry) => entry.path === 'hello.txt'));
  const teammateHeaders = {
    Cookie: `together_session=${createSessionToken({ sub: teammate.id, githubId: teammate.githubId, username: teammate.username })}`,
  };
  for (const cookie of [headers.Cookie, teammateHeaders.Cookie]) {
    const socket = io(origin, {
      auth: { workspaceId: id },
      extraHeaders: { Cookie: cookie },
      transports: ['websocket'],
      autoConnect: false,
      reconnection: false,
    });
    sockets.push(socket);
    const connected = event(socket, 'connect');
    socket.connect();
    await connected;
  }
  const [ownerSocket, teammateSocket] = sockets;
  const presence = event(teammateSocket, 'presence:update', (payload) =>
    payload.users.some((entry) => entry.id === user.id && entry.filePath === 'hello.txt'),
  );
  ownerSocket.emit('presence:update', { filePath: 'hello.txt' });
  await presence;
  const message = event(teammateSocket, 'chat:message');
  ownerSocket.emit('chat:send', { content: 'Cloud chat verified' });
  assert.equal((await message).content, 'Cloud chat verified');
  const versionEvent = event(teammateSocket, 'version:available');
  const commit = await fetch(base + '/git/commit', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Cloud version notification verified' }),
  });
  assert.equal(commit.status, 200);
  await versionEvent;
  teammateSocket.disconnect();
  const unseen = await (await fetch(base + '/versions', { headers: teammateHeaders })).json();
  assert.equal(unseen.unseenCount, 1, 'Version notice persists after teammate disconnects');
  const reviewed = await fetch(base + '/versions/reviewed', {
    method: 'POST',
    headers: { ...teammateHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activityId: unseen.updates[0].id }),
  });
  assert.equal(reviewed.status, 204);
  assert.equal(
    (await (await fetch(base + '/versions', { headers: teammateHeaders })).json()).unseenCount,
    0,
  );
  const upload = await fetch(base + '/datasets', {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'text/csv',
      'X-Dataset-Name': 'cloud-check.csv',
    },
    body: 'name,value\ncloud,42\n',
  });
  assert.equal(upload.status, 201, 'Object storage upload must work over the private network');
  datasetId = (await upload.json()).dataset.id;
  const started = await fetch(base + '/runtime/start', { method: 'POST', headers });
  assert.equal(
    started.status,
    200,
    'The restricted Docker API proxy must create workspace containers',
  );
  const status = await started.json();
  assert.equal(status.runtime.status, 'RUNNING');
  const command = await runtimeService.runWorkspaceCommand(id, [
    'python3',
    '-c',
    `from pathlib import Path; assert Path('/datasets/${datasetId}').read_text() == 'name,value\\ncloud,42\\n'; print('Dataset mount verified')`,
  ]);
  assert.equal(command.exitCode, 0, 'Dataset files must be mounted from the daemon host volume');
  assert(command.logTail.includes('Dataset mount verified'));
  console.log(
    'PASS: authenticated API, WebSocket chat/presence, commit notifications, offline version review, file storage, object upload, Docker runtime, and dataset mount.',
  );
} finally {
  sockets.forEach((socket) => socket.disconnect());
  await runtimeService.stopAndCleanup(id);
  if (datasetId) await workspaceDataService.deleteDataset(id, datasetId);
  await workspaceService.removeRoot(id);
  await prisma.workspace.deleteMany({ where: { id } });
  if (user) await prisma.user.deleteMany({ where: { id: user.id } });
  if (teammate) await prisma.user.deleteMany({ where: { id: teammate.id } });
  await prisma.$disconnect();
}
