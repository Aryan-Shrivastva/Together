import { z } from 'zod';

// Primary workspaces use UUIDs. Task workspaces created from Git worktrees use
// Prisma CUIDs, so workspace-facing APIs accept either opaque identifier.
export const workspaceIdSchema = z.union([z.string().uuid(), z.string().cuid()]);
