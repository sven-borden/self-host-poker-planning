CREATE TABLE "connector_token" (
	"user_id" text NOT NULL,
	"connector" text NOT NULL,
	"sealed_token" text NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_token_user_id_connector_pk" PRIMARY KEY("user_id","connector")
);
--> statement-breakpoint
ALTER TABLE "connector_token" ADD CONSTRAINT "connector_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;