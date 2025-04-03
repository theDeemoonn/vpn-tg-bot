/*
  Warnings:

  - A unique constraint covering the columns `[apiToken]` on the table `VpnServer` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "VpnServer" ADD COLUMN     "configData" TEXT,
ADD COLUMN     "initialUserId" TEXT,
ADD COLUMN     "realityPublicKey" TEXT,
ADD COLUMN     "realityShortId" TEXT,
ALTER COLUMN "location" DROP NOT NULL,
ALTER COLUMN "provider" DROP NOT NULL,
ALTER COLUMN "isActive" SET DEFAULT false,
ALTER COLUMN "maxClients" SET DEFAULT 100;

-- CreateIndex
CREATE UNIQUE INDEX "VpnServer_apiToken_key" ON "VpnServer"("apiToken");
