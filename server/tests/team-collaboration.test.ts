import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import { io, type Socket } from 'socket.io-client';

import { requireAuthentication, getSessionCookieName } from '../src/auth/middleware.js';
import { createSessionToken } from '../src/auth/session.js';
import { prisma } from '../src/db/client.js';
import { activityRouter } from '../src/routes/activity.js';
import { chatRouter } from '../src/routes/chat.js';
import { activityService } from '../src/services/activityService.js';
import { initializeWorkspaceSockets } from '../src/sockets/workspaceSockets.js';

test('team collaboration and durable version notifications', { timeout: 30_000 }, async (t) => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const sockets: Socket[] = [];
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', requireAuthentication, activityRouter, chatRouter);
  app.use(
    (
      error: { statusCode?: number; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      res.status(error.statusCode ?? 500).json({ error: error.message });
    },
  );
  const server = createServer(app);
  const socketServer = initializeWorkspaceSockets(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  const users = [];
  for (const name of ['owner', 'collaborator', 'viewer', 'outsider']) {
    const user = await prisma.user.create({
      data: {
        githubId: `test-${suffix}-${name}`,
        username: `test-${name}`,
        avatarUrl: 'https://example.com/avatar.png',
        githubAccessTokenEncrypted: 'unused-test-fixture',
      },
    });
    userIds.push(user.id);
    users.push({
      ...user,
      cookie: `${getSessionCookieName()}=${createSessionToken({ sub: user.id, githubId: user.githubId, username: user.username })}`,
    });
  }
  const [owner, collaborator, viewer, outsider] = users;
  assert(owner && collaborator && viewer && outsider);
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      name: 'Collaboration integration test',
      repoFullName: 'test/fixture',
      repoCloneUrl: 'https://github.com/test/fixture.git',
      defaultBranch: 'main',
      ownerId: owner.id,
      diskPath: `/unused/${workspaceId}`,
      status: 'READY',
      members: {
        create: [
          { userId: owner.id, role: 'OWNER', joinedAt: new Date(Date.now() - 60_000) },
          {
            userId: collaborator.id,
            role: 'COLLABORATOR',
            joinedAt: new Date(Date.now() - 60_000),
          },
          { userId: viewer.id, role: 'VIEWER', joinedAt: new Date(Date.now() - 60_000) },
        ],
      },
    },
  });
  await prisma.workspace.create({
    data: {
      id: otherWorkspaceId,
      name: 'Other test workspace',
      repoFullName: 'test/other',
      repoCloneUrl: 'https://github.com/test/other.git',
      defaultBranch: 'main',
      ownerId: outsider.id,
      diskPath: `/unused/${otherWorkspaceId}`,
      status: 'READY',
    },
  });
  const path = `/api/workspaces/${workspaceId}`;
  function get(endpoint: string, cookie?: string) {
    return fetch(base + endpoint, { headers: cookie ? { Cookie: cookie } : {} });
  }
  function reviewed(activityId: string, cookie: string) {
    return fetch(base + path + '/versions/reviewed', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activityId }),
    });
  }
  function event(socket: Socket, name: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(name, listener);
        reject(new Error(`Timed out waiting for ${name}`));
      }, 5000);
      function listener(payload: unknown) {
        clearTimeout(timer);
        resolve(payload);
      }
      socket.once(name, listener);
    });
  }
  async function connect(cookie: string) {
    const socket = io(base, {
      auth: { workspaceId },
      extraHeaders: { Cookie: cookie },
      transports: ['websocket'],
      autoConnect: false,
      reconnection: false,
    });
    sockets.push(socket);
    const connected = event(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
  }

  await t.test('requires authentication and workspace membership', async () => {
    assert.equal((await get(path + '/versions')).status, 401);
    assert.equal((await get(path + '/versions', outsider.cookie)).status, 403);
  });
  const first = await activityService.log(
    workspaceId,
    owner.id,
    'git.committed',
    'First shared version',
  );
  await t.test(
    'offline commits persist, exclude own commits, and allow viewers to read',
    async () => {
      const result = await (await get(path + '/versions', collaborator.cookie)).json();
      assert.equal(result.unseenCount, 1);
      assert.equal(result.updates[0].details, 'First shared version');
      assert.equal(result.updates[0].user.username, owner.username);
      assert.equal(
        (await (await get(path + '/versions', collaborator.cookie)).json()).unseenCount,
        1,
      );
      assert.equal((await (await get(path + '/versions', owner.cookie)).json()).unseenCount, 0);
      assert.equal((await (await get(path + '/versions', viewer.cookie)).json()).unseenCount, 1);
      assert.equal((await reviewed(first.id, outsider.cookie)).status, 403);
      assert.equal((await reviewed(first.id, viewer.cookie)).status, 204);
    },
  );
  const ownerSocket = await connect(owner.cookie);
  const collaboratorSocket = await connect(collaborator.cookie);
  await t.test('shows active files despite extra file/terminal connections', async () => {
    const presence = event(collaboratorSocket, 'presence:update');
    ownerSocket.emit('presence:update', { filePath: 'src/main.ts' });
    const payload = (await presence) as { users: Array<{ id: string; filePath: string | null }> };
    assert.equal(payload.users.find((u) => u.id === owner.id)?.filePath, 'src/main.ts');
    const nextPresence = event(collaboratorSocket, 'presence:update');
    await connect(owner.cookie);
    const nextPayload = (await nextPresence) as typeof payload;
    assert.equal(nextPayload.users.filter((u) => u.id === owner.id).length, 1);
    assert.equal(nextPayload.users.find((u) => u.id === owner.id)?.filePath, 'src/main.ts');
  });
  await t.test('delivers chat live and persists history; viewers cannot send', async () => {
    const received = event(collaboratorSocket, 'chat:message');
    ownerSocket.emit('chat:send', { content: 'Can you review src/main.ts?' });
    const message = (await received) as { id: string; content: string };
    assert.equal(message.content, 'Can you review src/main.ts?');
    const history = await (await get(path + '/messages', collaborator.cookie)).json();
    assert(history.messages.some((item: { id: string }) => item.id === message.id));
    const viewerSocket = await connect(viewer.cookie);
    const rejected = event(viewerSocket, 'chat:error');
    viewerSocket.emit('chat:send', { content: 'Not allowed' });
    assert.match(JSON.stringify(await rejected), /Viewers cannot/);
  });
  await t.test(
    'broadcasts versions and does not clear newer or cross-workspace versions',
    async () => {
      const liveUpdate = event(collaboratorSocket, 'version:available');
      const second = await activityService.log(
        workspaceId,
        owner.id,
        'branch.merged',
        'Feature task',
      );
      await liveUpdate;
      assert.equal((await reviewed(first.id, collaborator.cookie)).status, 204);
      let result = await (await get(path + '/versions', collaborator.cookie)).json();
      assert.equal(result.unseenCount, 1);
      assert.equal(result.updates[0].id, second.id);
      const other = await activityService.log(
        otherWorkspaceId,
        outsider.id,
        'git.committed',
        'Other workspace',
      );
      assert.equal((await reviewed(other.id, collaborator.cookie)).status, 404);
      assert.equal((await reviewed(second.id, collaborator.cookie)).status, 204);
      assert.equal((await reviewed(first.id, collaborator.cookie)).status, 204);
      result = await (await get(path + '/versions', collaborator.cookie)).json();
      assert.equal(result.unseenCount, 0);
      assert.equal((await (await get(path + '/versions', viewer.cookie)).json()).unseenCount, 1);
    },
  );
});
