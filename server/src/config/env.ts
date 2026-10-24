import { z } from 'zod';

const applicationEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGIN: z.string().url(),
  WORKSPACE_ROOT: z.string().min(1),
  WORKSPACE_CLONE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  MAX_FILE_OPEN_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
  FILE_TREE_MAX_ENTRIES: z.coerce.number().int().min(100).max(100_000).default(10_000),
  COLLABORATION_PERSIST_DEBOUNCE_MS: z.coerce.number().int().min(1_000).max(5_000).default(1_500),
  COLLABORATION_DOC_UNLOAD_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  FALKORDB_HOST: z.string().min(1).default('localhost'),
  FALKORDB_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
});

const base64KeySchema = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be a Base64-encoded 32-byte value');

const authenticationEnvironmentSchema = z.object({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_OAUTH_REDIRECT_URL: z.string().url(),
  JWT_SECRET: base64KeySchema,
  TOKEN_ENCRYPTION_KEY: base64KeySchema,
});

export const env = applicationEnvironmentSchema.parse(process.env);

export type AuthenticationConfig = z.infer<typeof authenticationEnvironmentSchema>;

export class AuthenticationConfigurationError extends Error {
  constructor() {
    super('Authentication configuration is incomplete.');
    this.name = 'AuthenticationConfigurationError';
  }
}

export function getAuthenticationConfig(): AuthenticationConfig {
  const result = authenticationEnvironmentSchema.safeParse(process.env);

  if (!result.success) {
    throw new AuthenticationConfigurationError();
  }

  return result.data;
}
