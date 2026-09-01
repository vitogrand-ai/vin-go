-- CreateTable
CREATE TABLE "catalog_translations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "source" TEXT NOT NULL,
    "ru" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_translations_source_key" ON "catalog_translations"("source");

