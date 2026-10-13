import { randomBytes } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { inviteRateLimit } from '../middleware/rateLimit.js';
import { membershipService } from '../services/membershipService.js';

const workspaceIdSchema = z.string().uuid();
const inviteIdSchema = z.string().cuid();
const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const emptyRequestBodySchema = z.object({}).strict();

function getInviteLink(token: string): string {
  return new URL(`/join/${token}`, env.CORS_ORIGIN).toString();
}

function toInviteResponse(invite: { id: string; token: string; expiresAt: Date }) {
  return {
    id: invite.id,
    link: getInviteLink(invite.token),
    expiresAt: invite.expiresAt,
  };
}

export const inviteRouter = Router();
inviteRouter.use(inviteRateLimit);

inviteRouter.post('/workspaces/:workspaceId/invites', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
    emptyRequestBodySchema.parse(request.body ?? {});

    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    await membershipService.requireOwner(workspaceId, userId);
    const expiresAt = new Date(Date.now() + env.INVITE_TTL_HOURS * 60 * 60 * 1_000);
    const invite = await prisma.invite.create({
      data: {
        workspaceId,
        createdById: userId,
        token: randomBytes(32).toString('base64url'),
        expiresAt,
      },
      select: { id: true, token: true, expiresAt: true },
    });

    response.status(201).json({ invite: toInviteResponse(invite) });
  } catch (error) {
    next(error);
  }
});

inviteRouter.delete(
  '/workspaces/:workspaceId/invites/:inviteId',
  async (request, response, next) => {
    try {
      const userId = request.authUser?.sub;
      const workspaceId = workspaceIdSchema.parse(request.params.workspaceId);
      const inviteId = inviteIdSchema.parse(request.params.inviteId);

      if (!userId) {
        throw new HttpError(401, 'Authentication is required.');
      }

      await membershipService.requireOwner(workspaceId, userId);
      const revoked = await prisma.invite.updateMany({
        where: { id: inviteId, workspaceId, revoked: false },
        data: { revoked: true },
      });

      if (revoked.count === 0) {
        throw new HttpError(404, 'The invite was not found or has already been revoked.');
      }

      response.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

inviteRouter.post('/join/:token', async (request, response, next) => {
  try {
    const userId = request.authUser?.sub;
    const token = inviteTokenSchema.parse(request.params.token);
    emptyRequestBodySchema.parse(request.body ?? {});

    if (!userId) {
      throw new HttpError(401, 'Authentication is required.');
    }

    const invite = await prisma.invite.findUnique({
      where: { token },
      select: { workspaceId: true, expiresAt: true, revoked: true },
    });

    if (!invite) {
      throw new HttpError(404, 'This invite link is invalid.');
    }

    if (invite.revoked) {
      throw new HttpError(410, 'This invite link has been revoked.');
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(410, 'This invite link has expired.');
    }

    const membership = await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
      create: { workspaceId: invite.workspaceId, userId, role: 'COLLABORATOR' },
      update: {},
      include: { workspace: true },
    });

    response.status(200).json({
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        repoFullName: membership.workspace.repoFullName,
        status: membership.workspace.status,
        role: membership.role,
      },
    });
  } catch (error) {
    next(error);
  }
});
