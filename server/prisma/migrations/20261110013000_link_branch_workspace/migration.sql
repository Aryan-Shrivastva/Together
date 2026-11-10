ALTER TABLE "Branch" ADD COLUMN "branchWorkspaceId" TEXT;

CREATE UNIQUE INDEX "Branch_branchWorkspaceId_key" ON "Branch"("branchWorkspaceId");
