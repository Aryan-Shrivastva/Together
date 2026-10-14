-- CreateEnum
CREATE TYPE "WorkspaceRuntimeStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'ERROR');

-- CreateTable
CREATE TABLE "WorkspaceRuntime" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dockerContainerId" TEXT,
    "dockerNetworkId" TEXT,
    "status" "WorkspaceRuntimeStatus" NOT NULL DEFAULT 'STOPPED',
    "dependencyFingerprint" TEXT,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceRuntime_workspaceId_key" ON "WorkspaceRuntime"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceRuntime_dockerContainerId_key" ON "WorkspaceRuntime"("dockerContainerId");

-- AddForeignKey
ALTER TABLE "WorkspaceRuntime" ADD CONSTRAINT "WorkspaceRuntime_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
