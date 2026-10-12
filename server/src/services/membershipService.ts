import type { WorkspaceRole } from '@prisma/client';

import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';

export type WorkspaceMembership = {
  role: WorkspaceRole;
};

export class MembershipService {
  async requireMember(workspaceId: string, userId: string): Promise<WorkspaceMembership> {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });

    if (!membership) {
      throw new HttpError(403, 'You are not a member of this workspace.');
    }

    return membership;
  }

  async requireOwner(workspaceId: string, userId: string): Promise<WorkspaceMembership> {
    const membership = await this.requireMember(workspaceId, userId);

    if (membership.role !== 'OWNER') {
      throw new HttpError(403, 'Only the workspace owner can manage invites.');
    }

    return membership;
  }
}

export const membershipService = new MembershipService();
