import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';

import { requireAuthentication } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { AuthenticationConfigurationError, env } from './config/env.js';
import { prisma } from './db/client.js';
import { HttpError } from './errors/httpError.js';
import { inviteRouter } from './routes/invites.js';
import { chatRouter } from './routes/chat.js';
import { fileRouter } from './routes/files.js';
import { workspaceRouter } from './routes/workspaces.js';
import { collaborationService } from './services/collaborationService.js';
import { initializeCollaborationSockets, initializeWorkspaceSockets } from './sockets/workspaceSockets.js';

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);

app.use('/api', requireAuthentication);
app.use('/api', workspaceRouter);
app.use('/api', inviteRouter);
app.use('/api', chatRouter);
app.use('/api', fileRouter);
app.get('/api/me', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;

    if (!userId) {
      response.status(401).json({ error: 'Authentication is required.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        githubId: true,
        username: true,
        avatarUrl: true,
        email: true,
        createdAt: true,
      },
    });

    if (!user) {
      response.status(401).json({ error: 'Your session is no longer valid.' });
      return;
    }

    response.status(200).json({ user });
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next;

    if (error instanceof AuthenticationConfigurationError) {
      response.status(503).json({ error: 'Authentication is not configured.' });
      return;
    }

    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error('Request failed.');
    response.status(500).json({ error: 'An unexpected server error occurred.' });
  },
);

const httpServer = createServer(app);
initializeWorkspaceSockets(httpServer);
initializeCollaborationSockets(httpServer);

httpServer.listen(env.SERVER_PORT, () => {
  console.info(`Server listening on port ${env.SERVER_PORT}`);
});

let isShuttingDown = false;

async function shutDown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  await collaborationService.flushAll();
  httpServer.close(() => process.exit(0));
}

process.once('SIGINT', () => void shutDown());
process.once('SIGTERM', () => void shutDown());
