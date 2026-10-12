import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';

import { AuthenticationConfigurationError, getAuthenticationConfig } from '../config/env.js';
import { verifySessionToken } from './session.js';

const SESSION_COOKIE_NAME = 'together_session';

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function requireAuthentication(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  try {
    getAuthenticationConfig();
  } catch (error) {
    if (error instanceof AuthenticationConfigurationError) {
      response.status(503).json({ error: 'Authentication is not configured.' });
      return;
    }

    next(error);
    return;
  }

  const token = request.cookies[SESSION_COOKIE_NAME];

  if (typeof token !== 'string' || token.length === 0) {
    response.status(401).json({ error: 'Authentication is required.' });
    return;
  }

  try {
    request.authUser = verifySessionToken(token);
    next();
  } catch (error) {
    if (error instanceof AuthenticationConfigurationError) {
      response.status(503).json({ error: 'Authentication is not configured.' });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError || error instanceof ZodError) {
      response.status(401).json({ error: 'Your session is invalid or has expired.' });
      return;
    }

    next(error);
  }
}
