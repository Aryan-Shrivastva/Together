import { prisma } from '../db/client.js';

export class ActivityService {
  async log(workspaceId: string, userId: string | undefined, action: string, details?: string) {
    return prisma.activityLog.create({
      data: {
        workspaceId,
        action,
        ...(userId ? { userId } : {}),
        ...(details ? { details } : {}),
      },
    });
  }

  async list(workspaceId: string) {
    return prisma.activityLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, username: true } } },
    });
  }
}

export const activityService = new ActivityService();
