-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "draft_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_draft_key_key" ON "orders"("draft_key");

