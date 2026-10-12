import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { getAuthenticationConfig } from '../config/env.js';

const sessionPayloadSchema = z.object({
  sub: z.string().min(1),
  githubId: z.string().min(1),
  username: z.string().min(1),
});

export type SessionUser = z.infer<typeof sessionPayloadSchema>;

const SESSION_ISSUER = 'together';
const SESSION_DURATION = '7d';

export function createSessionToken(user: SessionUser): string {
  const config = getAuthenticationConfig();

  return jwt.sign(user, Buffer.from(config.JWT_SECRET, 'base64'), {
    algorithm: 'HS256',
    expiresIn: SESSION_DURATION,
    issuer: SESSION_ISSUER,
  });
}

export function verifySessionToken(token: string): SessionUser {
  const config = getAuthenticationConfig();
  const payload = jwt.verify(token, Buffer.from(config.JWT_SECRET, 'base64'), {
    algorithms: ['HS256'],
    issuer: SESSION_ISSUER,
  });

  return sessionPayloadSchema.parse(payload);
}
