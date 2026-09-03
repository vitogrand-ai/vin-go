-- CreateEnum
CREATE TYPE "expert_request_status" AS ENUM ('NEW', 'ANSWERED', 'REJECTED');

-- CreateTable
CREATE TABLE "expert_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "number" SERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "vin" TEXT NOT NULL,
    "vehicle" JSONB,
    "query" TEXT NOT NULL,
    "comment" TEXT,
    "status" "expert_request_status" NOT NULL DEFAULT 'NEW',
    "answer_text" TEXT,
    "answer_oems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answered_by" UUID,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expert_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_sessions" (
    "chat_id" BIGINT NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_sessions_pkey" PRIMARY KEY ("chat_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expert_requests_number_key" ON "expert_requests"("number");

-- CreateIndex
CREATE INDEX "expert_requests_status_created_at_idx" ON "expert_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "expert_requests_org_id_created_at_idx" ON "expert_requests"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "expert_requests" ADD CONSTRAINT "expert_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_requests" ADD CONSTRAINT "expert_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

