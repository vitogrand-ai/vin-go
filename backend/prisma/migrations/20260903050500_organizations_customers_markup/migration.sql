-- CreateEnum
CREATE TYPE "org_role" AS ENUM ('OWNER', 'MEMBER');

-- DropIndex
DROP INDEX "vehicles_user_id_idx";

-- DropIndex
DROP INDEX "vehicles_user_id_vin_key";

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "markup_bps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sale_amount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "number" SERIAL NOT NULL,
ADD COLUMN     "org_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "org_id" UUID,
ADD COLUMN     "org_role" "org_role" NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "mileage_km" INTEGER,
ADD COLUMN     "org_id" UUID,
ADD COLUMN     "plate" TEXT;

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "default_markup_bps" INTEGER NOT NULL DEFAULT 0,
    "invite_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_invite_code_key" ON "organizations"("invite_code");

-- CreateIndex
CREATE INDEX "customers_org_id_name_idx" ON "customers"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "orders_number_key" ON "orders"("number");

-- CreateIndex
CREATE INDEX "orders_org_id_status_placed_at_idx" ON "orders"("org_id", "status", "placed_at");

-- CreateIndex
CREATE INDEX "users_org_id_idx" ON "users"("org_id");

-- CreateIndex
CREATE INDEX "vehicles_org_id_plate_idx" ON "vehicles"("org_id", "plate");

-- CreateIndex
CREATE INDEX "vehicles_customer_id_idx" ON "vehicles"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_org_id_vin_key" ON "vehicles"("org_id", "vin");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

