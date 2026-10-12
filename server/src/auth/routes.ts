import { randomBytes } from 'node:crypto';

import type { CookieOptions, Response } from 'express';
import { Router } from 'express';
import { Octokit } from 'octokit';
import { ZodError, z } from 'zod';

import { AuthenticationConfigurationError, env, getAuthenticationConfig } from '../config/env.js';
import { prisma } from '../db/client.js';
import { encryptGitHubToken } from './crypto.js';
import { getSessionCookieName } from './middleware.js';
import { createSessionToken } from './session.js';

const OAUTH_STATE_COOKIE_NAME = 'together_oauth_state';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().min(1).max(128).optional(),
});
const authorizationQuerySchema = z.object({
  returnTo: z.string().max(2_048).optional(),
});
const oauthStateCookieSchema = z.object({
  state: z.string().min(1).max(512),
  returnTo: z
    .string()
    .startsWith('/')
    .max(2_048)
    .refine((value) => !value.startsWith('//'), 'must be a same-site path'),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  scope: z.string().optional(),
});

function cookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  };
}

function getSafeReturnTo(value: string | undefined): string {
  if (!value) {
    return '/';
  }

  try {
    const clientOrigin = new URL(env.CORS_ORIGIN);
    const destination = new URL(value, clientOrigin);

    if (destination.origin !== clientOrigin.origin || !destination.pathname.startsWith('/')) {
      return '/';
    }

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return '/';
  }
}

function redirectToClient(
  response: Response,
  outcome: 'failed' | 'signed-out' | 'signed-in',
  returnTo = '/',
) {
  const destination = new URL(returnTo, env.CORS_ORIGIN);
  destination.searchParams.set('auth', outcome);
  response.redirect(destination.toString());
}

async function exchangeAuthorizationCode(code: string): Promise<string> {
  const config = getAuthenticationConfig();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: config.GITHUB_OAUTH_REDIRECT_URL,
    }),
  });

  if (!response.ok) {
    throw new Error('GitHub token exchange failed.');
  }

  const payload: unknown = await response.json();
  const parsedPayload = tokenResponseSchema.safeParse(payload);

  if (!parsedPayload.success) {
    throw new Error('GitHub token exchange returned an invalid response.');
  }

  return parsedPayload.data.access_token;
}

async function getGitHubProfile(accessToken: string) {
  const octokit = new Octokit({ auth: accessToken });
  const profile = await octokit.rest.users.getAuthenticated();
  const emailResponse = await octokit.rest.users.listEmailsForAuthenticatedUser();
  const primaryEmail = emailResponse.data.find((email) => email.primary && email.verified)?.email;

  return {
    githubId: String(profile.data.id),
    username: profile.data.login,
    avatarUrl: profile.data.avatar_url,
    email: primaryEmail ?? profile.data.email ?? null,
  };
}

export const authRouter = Router();

authRouter.get('/github', (request, response, next) => {
  try {
    const config = getAuthenticationConfig();
    const query = authorizationQuerySchema.safeParse(request.query);
    const state = randomBytes(32).toString('base64url');
    const returnTo = getSafeReturnTo(query.success ? query.data.returnTo : undefined);
    const authorizationUrl = new URL('https://github.com/login/oauth/authorize');

    authorizationUrl.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
    authorizationUrl.searchParams.set('redirect_uri', config.GITHUB_OAUTH_REDIRECT_URL);
    authorizationUrl.searchParams.set('scope', 'read:user user:email repo');
    authorizationUrl.searchParams.set('state', state);

    response.cookie(
      OAUTH_STATE_COOKIE_NAME,
      JSON.stringify({ state, returnTo }),
      cookieOptions(OAUTH_STATE_MAX_AGE_MS),
    );
    response.redirect(authorizationUrl.toString());
  } catch (error) {
    next(error);
  }
});

authRouter.get('/github/callback', async (request, response, next) => {
  try {
    const query = callbackQuerySchema.parse(request.query);
    const storedStateCookie = request.cookies[OAUTH_STATE_COOKIE_NAME];
    response.clearCookie(OAUTH_STATE_COOKIE_NAME, cookieOptions(0));
    const storedState = (() => {
      if (typeof storedStateCookie !== 'string') {
        return undefined;
      }

      try {
        const parsedState = oauthStateCookieSchema.safeParse(JSON.parse(storedStateCookie));
        return parsedState.success ? parsedState.data : undefined;
      } catch {
        return undefined;
      }
    })();

    if (
      query.error ||
      !query.code ||
      !query.state ||
      !storedState ||
      query.state !== storedState.state
    ) {
      redirectToClient(response, 'failed');
      return;
    }

    const accessToken = await exchangeAuthorizationCode(query.code);
    const profile = await getGitHubProfile(accessToken);
    const config = getAuthenticationConfig();
    const encryptedToken = encryptGitHubToken(accessToken, config.TOKEN_ENCRYPTION_KEY);
    const user = await prisma.user.upsert({
      where: { githubId: profile.githubId },
      create: {
        ...profile,
        githubAccessTokenEncrypted: encryptedToken,
      },
      update: {
        username: profile.username,
        avatarUrl: profile.avatarUrl,
        email: profile.email,
        githubAccessTokenEncrypted: encryptedToken,
      },
    });

    const sessionToken = createSessionToken({
      sub: user.id,
      githubId: user.githubId,
      username: user.username,
    });

    response.cookie(getSessionCookieName(), sessionToken, cookieOptions(SESSION_MAX_AGE_MS));
    redirectToClient(response, 'signed-in', storedState.returnTo);
  } catch (error) {
    if (error instanceof AuthenticationConfigurationError) {
      response.status(503).json({ error: 'Authentication is not configured.' });
      return;
    }

    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Invalid OAuth callback.' });
      return;
    }

    console.error('GitHub OAuth callback failed.');
    next(error);
  }
});

authRouter.post('/logout', (_request, response) => {
  response.clearCookie(getSessionCookieName(), cookieOptions(0));
  response.status(204).send();
});
