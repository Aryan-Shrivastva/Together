import { prisma } from '../db/client.js';

export const versionActions = ['git.committed', 'git.pulled', 'branch.merged'];

export class ActivityService {
  private versionListener: ((workspaceId: string) => void) | undefined;

  setVersionListener(listener: (workspaceId: string) => void): void {
    this.versionListener = listener;
  }

  async log(workspaceId: string, userId: string | undefined, action: string, details?: string) {
    const activity = await prisma.activityLog.create({
      data: {
        workspaceId,
        action,
        ...(userId ? { userId } : {}),
        ...(details ? { details } : {}),
      },
    });
    if (versionActions.includes(action)) this.versionListener?.(workspaceId);
    return activity;
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
