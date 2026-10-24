import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { ZodError } from 'zod';

import { requireAuthentication } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { AuthenticationConfigurationError, env } from './config/env.js';
import { prisma } from './db/client.js';
import { HttpError } from './errors/httpError.js';
import { authRateLimit } from './middleware/rateLimit.js';
import { inviteRouter } from './routes/invites.js';
import { brainRouter } from './routes/brain.js';
import { chatRouter } from './routes/chat.js';
import { gitRouter } from './routes/git.js';
import { fileRouter } from './routes/files.js';
import { workspaceRouter } from './routes/workspaces.js';
import { collaborationService } from './services/collaborationService.js';
import {
  initializeCollaborationSockets,
  initializeWorkspaceSockets,
} from './sockets/workspaceSockets.js';

const app = express();

function isHttpError(error: unknown): error is HttpError {
  if (error instanceof HttpError) {
    return true;
  }

  // The development server reloads TypeScript modules in place. During a
  // reload, an error can have been created by the previous HttpError class
  // instance, making `instanceof` unreliable even though it is a safe,
  // application-created HTTP error.
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode <= 599 &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

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

app.use('/auth', authRateLimit, authRouter);

app.use('/api', requireAuthentication);
app.use('/api', workspaceRouter);
app.use('/api', inviteRouter);
app.use('/api', chatRouter);
app.use('/api', brainRouter);
app.use('/api', gitRouter);
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
    request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next;

    if (error instanceof AuthenticationConfigurationError) {
      response.status(503).json({ error: 'Authentication is not configured.' });
      return;
    }

    if (isHttpError(error)) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }

    if (error instanceof ZodError) {
      response.status(400).json({ error: 'The submitted data is invalid.' });
      return;
    }

    // Keep diagnostics useful without echoing error messages, which may include
    // credentials from an upstream Git operation.
    console.error('Request failed.', {
      method: request.method,
      path: request.path,
      name: error instanceof Error ? error.name : typeof error,
      code:
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined,
    });
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
