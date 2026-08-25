DROP INDEX `booking_slots_slot_unique`;--> statement-breakpoint
ALTER TABLE `booking_slots` ADD `day_of_week` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `booking_slots` ADD `start_minute` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `booking_slots` ADD `end_minute` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `booking_slots_time_idx` ON `booking_slots` (`day_of_week`,`start_minute`,`end_minute`);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_slots_slot_unique` ON `booking_slots` (`availability_slot_id`,`booking_id`,`visit_ordinal`);--> statement-breakpoint
DROP INDEX `request_slots_held_slot_unique`;--> statement-breakpoint
ALTER TABLE `request_slots` ADD `day_of_week` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_slots` ADD `start_minute` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_slots` ADD `end_minute` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `request_slots_time_idx` ON `request_slots` (`day_of_week`,`start_minute`,`end_minute`);--> statement-breakpoint
CREATE UNIQUE INDEX `request_slots_held_slot_unique` ON `request_slots` (`availability_slot_id`,`request_id`,`visit_ordinal`);