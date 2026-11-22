import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { versionActions } from './activityService.js';

export class VersionService {
  async unread(workspaceId: string, userId: string) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new HttpError(403, 'You are not a member of this workspace.');
    const where = {
      workspaceId,
      action: { in: versionActions },
      createdAt: { gt: member.versionsSeenAt ?? member.joinedAt },
      OR: [{ userId: { not: userId } }, { userId: null }],
    };
    const [updates, unseenCount] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          action: true,
          details: true,
          createdAt: true,
          user: { select: { id: true, username: true } },
        },
      }),
      prisma.activityLog.count({ where }),
    ]);
    return { updates, unseenCount };
  }

  async markReviewed(workspaceId: string, userId: string, activityId: string): Promise<void> {
    const activity = await prisma.activityLog.findFirst({
      where: { id: activityId, workspaceId, action: { in: versionActions } },
      select: { createdAt: true },
    });
    if (!activity) throw new HttpError(404, 'Workspace version not found.');
    // Acknowledge only the version the user reviewed, never a newer concurrent commit.
    // Conditional update also prevents an older browser tab moving the read cursor backwards.
    await prisma.workspaceMember.updateMany({
      where: {
        workspaceId,
        userId,
        OR: [{ versionsSeenAt: null }, { versionsSeenAt: { lt: activity.createdAt } }],
      },
      data: { versionsSeenAt: activity.createdAt },
    });
  }
}

export const versionService = new VersionService();
