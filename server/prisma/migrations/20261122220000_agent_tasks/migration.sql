CREATE TABLE "AgentTask" (
 "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "username" TEXT NOT NULL,
 "prompt" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued', "progress" TEXT NOT NULL DEFAULT 'Waiting to start',
 "branchId" TEXT, "branchWorkspaceId" TEXT, "branchName" TEXT, "result" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "AgentTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentTask_workspaceId_createdAt_idx" ON "AgentTask"("workspaceId", "createdAt");
