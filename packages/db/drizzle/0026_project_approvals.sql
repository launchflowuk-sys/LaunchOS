ALTER TYPE "public"."approval_kind" ADD VALUE 'client_review';--> statement-breakpoint
ALTER TYPE "public"."approval_kind" ADD VALUE 'project_update';--> statement-breakpoint
ALTER TYPE "public"."approval_kind" ADD VALUE 'case_study_publish';--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_client_review" ON "approvals" USING btree ("organisation_id",("payload" ->> 'targetRef')) WHERE "approvals"."status" = 'pending' and "approvals"."deleted_at" is null and "approvals"."payload" ->> 'action' = 'client_review';--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_project_update" ON "approvals" USING btree ("organisation_id",("payload" ->> 'projectId')) WHERE "approvals"."status" = 'pending' and "approvals"."payload" ->> 'action' = 'project_update';
