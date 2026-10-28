CREATE TABLE "room_access" (
	"room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_access_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room" ADD COLUMN "password_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room" ADD COLUMN "password_failures_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_access" ADD CONSTRAINT "room_access_room_id_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_access" ADD CONSTRAINT "room_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;