import type { Server as HttpServer } from 'node:http';

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { Server } from 'socket.io';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

import { getSessionCookieName } from '../auth/middleware.js';
import { verifySessionToken } from '../auth/session.js';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { collaborationService } from '../services/collaborationService.js';
import { fileService } from '../services/fileService.js';
import { membershipService } from '../services/membershipService.js';
import { terminalService } from '../services/terminalService.js';
import { SlidingWindowRateLimiter } from '../middleware/rateLimit.js';
import { workspaceIdSchema } from '../validation/workspace.js';

const chatMessageRateLimiter = new SlidingWindowRateLimiter(60 * 1_000, 30);
const terminalInputRateLimiter = new SlidingWindowRateLimiter(1_000, 240);
let socketServer: Server | undefined;
const require = createRequire(import.meta.url);
const yWebsocketUtilitiesPath = resolve(
  dirname(require.resolve('y-websocket')),
  '..',
  'bin',
  'utils.js',
);
const { setupWSConnection } = require(yWebsocketUtilitiesPath) as {
  setupWSConnection: (
    connection: import('ws').WebSocket,
    request: import('node:http').IncomingMessage,
    options: { docName: string },
  ) => void;
};

function workspaceRoom(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

async function emitPresence(workspaceId: string): Promise<void> {
  const sockets = await socketServer?.in(workspaceRoom(workspaceId)).fetchSockets();
  const users = new Map<
    string,
    { id: string; username: string; avatarUrl: string; filePath: string | null }
  >();
  for (const socket of sockets ?? []) {
    const user = socket.data.user as
      { id: string; username: string; avatarUrl: string } | undefined;
    if (user)
      users.set(user.id, {
        ...user,
        filePath: (socket.data.filePath as string | null | undefined) ?? null,
      });
  }
  socketServer
    ?.to(workspaceRoom(workspaceId))
    .emit('presence:update', { users: [...users.values()] });
}

function getCookieValue(cookieHeader: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const matchingCookie = cookieHeader
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));

  if (!matchingCookie) {
    return undefined;
  }

  try {
    return decodeURIComponent(matchingCookie.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export function initializeWorkspaceSockets(httpServer: HttpServer): Server {
  socketServer = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN,
      credentials: true,
    },
  });
  collaborationService.setPersistenceFailureListener((target) => {
    socketServer?.to(workspaceRoom(target.workspaceId)).emit('collaboration:error', {
      error: `Unable to save ${target.path}. Editing is paused until saving recovers.`,
    });
  });
  terminalService.setOutputListener((workspaceId, output) => {
    socketServer?.to(workspaceRoom(workspaceId)).emit('terminal:output', { output });
  });

  socketServer.use(async (socket, next) => {
    try {
      const workspaceId = workspaceIdSchema.parse(socket.handshake.auth.workspaceId);
      const sessionToken = getCookieValue(
        socket.handshake.headers.cookie ?? '',
        getSessionCookieName(),
      );

      if (!sessionToken) {
        next(new Error('Authentication is required.'));
        return;
      }

      const user = verifySessionToken(sessionToken);
      const membership = await membershipService.requireMember(workspaceId, user.sub);
      const databaseUser = await prisma.user.findUnique({
        where: { id: user.sub },
        select: { id: true, username: true, avatarUrl: true },
      });
      if (!databaseUser) throw new Error('User no longer exists.');
      socket.data.workspaceId = workspaceId;
      socket.data.role = membership.role;
      socket.data.user = databaseUser;
      socket.join(workspaceRoom(workspaceId));
      next();
    } catch {
      next(new Error('You are not authorized to join this workspace.'));
    }
  });

  socketServer.on('connection', (socket) => {
    const workspaceId = socket.data.workspaceId as string;
    void emitPresence(workspaceId);
    socket.on('presence:update', (payload: unknown) => {
      const result = z
        .object({ filePath: z.string().min(1).max(1024).nullable() })
        .safeParse(payload);
      if (result.success) socket.data.filePath = result.data.filePath;
      void emitPresence(workspaceId);
    });
    socket.on('chat:send', async (payload: unknown) => {
      if (socket.data.role === 'VIEWER') {
        socket.emit('chat:error', { error: 'Viewers cannot send workspace messages.' });
        return;
      }
      const result = z.object({ content: z.string().trim().min(1).max(5_000) }).safeParse(payload);
      if (!result.success) return;
      const user = socket.data.user as { id: string };
      const rateLimit = chatMessageRateLimiter.check(`${workspaceId}:${user.id}`);
      if (!rateLimit.allowed) {
        socket.emit('chat:error', {
          error: `You are sending messages too quickly. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
        });
        return;
      }
      const message = await prisma.chatMessage.create({
        data: { workspaceId, userId: user.id, content: result.data.content },
        include: { user: { select: { id: true, username: true, avatarUrl: true } } },
      });
      socketServer?.to(workspaceRoom(workspaceId)).emit('chat:message', {
        id: message.id,
        content: message.content,
        createdAt: message.createdAt,
        user: message.user,
      });
    });
    socket.on('terminal:attach', async () => {
      if (socket.data.role === 'VIEWER') {
        socket.emit('terminal:error', { error: 'Viewers cannot use the shared terminal.' });
        return;
      }
      try {
        const terminal = await terminalService.attach(workspaceId);
        socket.emit('terminal:reset', terminal);
        socketServer?.to(workspaceRoom(workspaceId)).emit('terminal:status', {
          message: `${(socket.data.user as { username: string }).username} joined the shared terminal.`,
        });
      } catch {
        socket.emit('terminal:error', { error: 'Unable to start the shared terminal.' });
      }
    });
    socket.on('terminal:input', (payload: unknown) => {
      if (socket.data.role === 'VIEWER') {
        socket.emit('terminal:error', { error: 'Viewers cannot use the shared terminal.' });
        return;
      }
      const result = z.object({ input: z.string().max(8_192) }).safeParse(payload);
      const user = socket.data.user as { id: string };
      const rateLimit = terminalInputRateLimiter.check(`${workspaceId}:${user.id}`);
      if (!result.success || !rateLimit.allowed) {
        socket.emit('terminal:error', {
          error: 'Terminal input was rejected. Please slow down and retry.',
        });
        return;
      }
      try {
        terminalService.write(workspaceId, result.data.input);
      } catch (error) {
        socket.emit('terminal:error', {
          error: error instanceof Error ? error.message : 'Unable to send terminal input.',
        });
      }
    });
    socket.on('terminal:resize', (payload: unknown) => {
      if (socket.data.role === 'VIEWER') return;
      const result = z
        .object({
          columns: z.number().int().min(20).max(300),
          rows: z.number().int().min(5).max(120),
        })
        .safeParse(payload);
      if (result.success)
        terminalService.resize(workspaceId, result.data.columns, result.data.rows);
    });
    socket.on('terminal:run', async (payload: unknown) => {
      if (socket.data.role === 'VIEWER') {
        socket.emit('terminal:error', { error: 'Viewers cannot run workspace tasks.' });
        return;
      }
      const result = z.object({ task: z.enum(['run', 'test']) }).safeParse(payload);
      if (!result.success) {
        socket.emit('terminal:error', { error: 'Unknown workspace task.' });
        return;
      }
      try {
        const user = socket.data.user as { username: string };
        await terminalService.runTask(workspaceId, result.data.task, user.username);
      } catch (error) {
        socket.emit('terminal:error', {
          error: error instanceof Error ? error.message : 'Unable to run the workspace task.',
        });
      }
    });
    socket.on('disconnect', () => void emitPresence(workspaceId));
  });

  return socketServer;
}

export function emitFileSystemChanged(workspaceId: string): void {
  socketServer?.to(workspaceRoom(workspaceId)).emit('fs:changed', { workspaceId });
}

export function initializeCollaborationSockets(httpServer: HttpServer): void {
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/yjs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      return;
    }

    const workspaceId = match[1];
    const encodedPath = match[2];
    if (!workspaceId || !encodedPath) {
      socket.destroy();
      return;
    }

    void (async () => {
      try {
        const sessionToken = getCookieValue(request.headers.cookie ?? '', getSessionCookieName());
        if (!sessionToken) {
          throw new Error('Authentication is required.');
        }

        const user = verifySessionToken(sessionToken);
        const path = decodeURIComponent(encodedPath);
        workspaceIdSchema.parse(workspaceId);
        await membershipService.requireEditor(workspaceId, user.sub);
        await fileService.readTextFile(workspaceId, path);

        const documentName = collaborationService.documentName({ workspaceId, path });
        await collaborationService.prepareDocument(documentName);
        webSocketServer.handleUpgrade(request, socket, head, (connection) => {
          collaborationService.cancelScheduledUnload(documentName);
          connection.on('close', () => collaborationService.scheduleUnload(documentName));
          setupWSConnection(connection, request, { docName: documentName });
        });
      } catch {
        socket.destroy();
      }
    })();
  });
}
