-- CreateTable
CREATE TABLE "vin_decodes" (
    "vin" TEXT NOT NULL,
    "vehicle" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "decoded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vin_decodes_pkey" PRIMARY KEY ("vin")
);

-- CreateIndex
CREATE INDEX "vin_decodes_expires_at_idx" ON "vin_decodes"("expires_at");
