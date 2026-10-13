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
import { SlidingWindowRateLimiter } from '../middleware/rateLimit.js';

const workspaceIdSchema = z.string().uuid();
const chatMessageRateLimiter = new SlidingWindowRateLimiter(60 * 1_000, 30);
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
      await membershipService.requireMember(workspaceId, user.sub);
      const databaseUser = await prisma.user.findUnique({
        where: { id: user.sub },
        select: { id: true, username: true, avatarUrl: true },
      });
      if (!databaseUser) throw new Error('User no longer exists.');
      socket.data.workspaceId = workspaceId;
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
    const match = /^\/yjs\/([0-9a-f-]{36})\/([^/]+)$/i.exec(url.pathname);
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
        await membershipService.requireMember(workspaceId, user.sub);
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
