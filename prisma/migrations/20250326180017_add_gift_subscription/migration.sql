-- CreateEnum
CREATE TYPE "GiftStatus" AS ENUM ('PENDING', 'PAID', 'REDEEMED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "GiftSubscription" (
    "id" SERIAL NOT NULL,
    "senderId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "status" "GiftStatus" NOT NULL,
    "paymentId" TEXT,
    "subscriptionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),

    CONSTRAINT "GiftSubscription_pkey" PRIMARY KEY ("id")
);
