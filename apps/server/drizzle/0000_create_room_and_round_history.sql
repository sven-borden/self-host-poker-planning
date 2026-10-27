CREATE TABLE "room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"owner_user_id" text NOT NULL,
	"live" jsonb NOT NULL,
	"version" integer NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "round_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "round_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"room_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"subject" jsonb NOT NULL,
	"deck" jsonb NOT NULL,
	"votes" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"final" text,
	"started_at" timestamp with time zone NOT NULL,
	"revealed_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "round_history_room_id_number_unique" UNIQUE("room_id","number")
);
--> statement-breakpoint
ALTER TABLE "round_history" ADD CONSTRAINT "round_history_room_id_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_last_active_at_idx" ON "room" USING btree ("last_active_at");