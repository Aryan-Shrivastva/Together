CREATE TYPE "PreviewStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'ERROR');

CREATE TABLE "Preview" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dockerContainerId" TEXT,
    "dockerNetworkId" TEXT,
    "port" INTEGER NOT NULL,
    "status" "PreviewStatus" NOT NULL DEFAULT 'STOPPED',
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Preview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Preview_workspaceId_key" ON "Preview"("workspaceId");
CREATE UNIQUE INDEX "Preview_dockerContainerId_key" ON "Preview"("dockerContainerId");
CREATE INDEX "Preview_status_updatedAt_idx" ON "Preview"("status", "updatedAt");

ALTER TABLE "Preview" ADD CONSTRAINT "Preview_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
