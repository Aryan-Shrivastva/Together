-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "worktreePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Branch_worktreePath_key" ON "Branch"("worktreePath");

-- CreateIndex
CREATE INDEX "Branch_workspaceId_createdAt_idx" ON "Branch"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_workspaceId_name_key" ON "Branch"("workspaceId", "name");

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
