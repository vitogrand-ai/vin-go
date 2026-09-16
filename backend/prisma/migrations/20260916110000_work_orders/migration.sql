-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "complaint" TEXT,
ADD COLUMN     "condition_notes" TEXT,
ADD COLUMN     "due_at" TIMESTAMP(3),
ADD COLUMN     "mileage_km" INTEGER,
ADD COLUMN     "plate" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "address" TEXT,
ADD COLUMN     "inn" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "ogrn" TEXT,
ADD COLUMN     "warranty_text" TEXT;

-- CreateTable
CREATE TABLE "order_works" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_works_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_works_order_id_idx" ON "order_works"("order_id");

-- AddForeignKey
ALTER TABLE "order_works" ADD CONSTRAINT "order_works_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

