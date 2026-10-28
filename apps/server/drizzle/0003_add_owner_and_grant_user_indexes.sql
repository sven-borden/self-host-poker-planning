CREATE INDEX "room_owner_user_id_idx" ON "room" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "room_access_user_id_idx" ON "room_access" USING btree ("user_id");