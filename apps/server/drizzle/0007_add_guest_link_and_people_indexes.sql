CREATE TABLE "guest_link" (
	"guest_user_id" text PRIMARY KEY NOT NULL,
	"account_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "claimed_email" text;--> statement-breakpoint
ALTER TABLE "guest_link" ADD CONSTRAINT "guest_link_guest_user_id_user_id_fk" FOREIGN KEY ("guest_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_link" ADD CONSTRAINT "guest_link_account_user_id_user_id_fk" FOREIGN KEY ("account_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_link_account_user_id_idx" ON "guest_link" USING btree ("account_user_id");--> statement-breakpoint
CREATE INDEX "room_people_idx" ON "room" USING gin (((live -> 'participants') || coalesce(live #> '{round,votes}', '{}'::jsonb)));--> statement-breakpoint
CREATE INDEX "round_history_votes_idx" ON "round_history" USING gin ("votes" jsonb_path_ops);