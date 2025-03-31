/*
  Warnings:

  - Made the column `paymentMethod` on table `Payment` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "json_data" JSONB,
ALTER COLUMN "currency" DROP DEFAULT,
ALTER COLUMN "status" SET DEFAULT 'PENDING',
ALTER COLUMN "paymentMethod" SET NOT NULL,
ALTER COLUMN "paymentMethod" SET DEFAULT 'UNKNOWN';

-- CreateTable
CREATE TABLE "PaymentInvoiceData" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "prices" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentInvoiceData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLog" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentInvoiceData_payment_id_key" ON "PaymentInvoiceData"("payment_id");

-- AddForeignKey
ALTER TABLE "PaymentInvoiceData" ADD CONSTRAINT "PaymentInvoiceData_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
