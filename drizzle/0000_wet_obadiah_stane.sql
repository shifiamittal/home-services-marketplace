CREATE TABLE `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`anonymous_id` text,
	`session_id` text,
	`event_name` text NOT NULL,
	`properties_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `analytics_events_name_time_idx` ON `analytics_events` (`event_name`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `analytics_events_user_time_idx` ON `analytics_events` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `availability_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`helper_user_id` text NOT NULL,
	`day_of_week` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`buffer_minutes` integer DEFAULT 15 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `availability_slots_helper_day_idx` ON `availability_slots` (`helper_user_id`,`day_of_week`);--> statement-breakpoint
CREATE TABLE `booking_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`resident_user_id` text NOT NULL,
	`helper_user_id` text NOT NULL,
	`resident_address_id` text NOT NULL,
	`package_snapshot_json` text NOT NULL,
	`monthly_price_paise` integer NOT NULL,
	`requested_start_date` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_due_at` text NOT NULL,
	`responded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_address_id`) REFERENCES `resident_addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_requests_resident_idx` ON `booking_requests` (`resident_user_id`);--> statement-breakpoint
CREATE INDEX `booking_requests_helper_idx` ON `booking_requests` (`helper_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `booking_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`availability_slot_id` text NOT NULL,
	`visit_ordinal` integer NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`availability_slot_id`) REFERENCES `availability_slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_slots_booking_idx` ON `booking_slots` (`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_slots_slot_unique` ON `booking_slots` (`availability_slot_id`);--> statement-breakpoint
CREATE TABLE `booking_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_user_id` text,
	`reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_status_history_booking_idx` ON `booking_status_history` (`booking_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`resident_user_id` text NOT NULL,
	`helper_user_id` text NOT NULL,
	`status` text DEFAULT 'trial' NOT NULL,
	`trial_visits_allowed` integer DEFAULT 2 NOT NULL,
	`trial_visits_completed` integer DEFAULT 0 NOT NULL,
	`cycle_started_at` text NOT NULL,
	`cycle_ends_at` text NOT NULL,
	`renewal_enabled` integer DEFAULT false NOT NULL,
	`ended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `booking_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_request_unique` ON `bookings` (`request_id`);--> statement-breakpoint
CREATE INDEX `bookings_resident_status_idx` ON `bookings` (`resident_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_helper_status_idx` ON `bookings` (`helper_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_type` text NOT NULL,
	`document_version` text NOT NULL,
	`accepted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `consents_user_idx` ON `consents` (`user_id`);--> statement-breakpoint
CREATE TABLE `helper_offerings` (
	`id` text PRIMARY KEY NOT NULL,
	`helper_user_id` text NOT NULL,
	`service_type` text NOT NULL,
	`home_size` text NOT NULL,
	`monthly_price_paise` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `helper_offerings_helper_idx` ON `helper_offerings` (`helper_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `helper_offerings_package_unique` ON `helper_offerings` (`helper_user_id`,`service_type`,`home_size`);--> statement-breakpoint
CREATE TABLE `helper_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`home_locality` text NOT NULL,
	`landmark` text,
	`latitude_e6` integer,
	`longitude_e6` integer,
	`years_experience` integer DEFAULT 0 NOT NULL,
	`verification_status` text DEFAULT 'not_submitted' NOT NULL,
	`profile_status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `issue_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text,
	`changed_by` text DEFAULT 'manual_backend_review' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_status_history_issue_idx` ON `issue_status_history` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`case_number` integer NOT NULL,
	`booking_id` text,
	`reporter_user_id` text NOT NULL,
	`reported_user_id` text,
	`category` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'new' NOT NULL,
	`internal_resolution_note` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reported_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_case_number_unique` ON `issues` (`case_number`);--> statement-breakpoint
CREATE INDEX `issues_status_created_idx` ON `issues` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`template_key` text NOT NULL,
	`related_entity_type` text,
	`related_entity_id` text,
	`provider_message_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notification_log_user_idx` ON `notification_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `notification_log_status_idx` ON `notification_log` (`status`);--> statement-breakpoint
CREATE TABLE `request_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`availability_slot_id` text NOT NULL,
	`visit_ordinal` integer NOT NULL,
	`includes_house_cleaning` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `booking_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`availability_slot_id`) REFERENCES `availability_slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `request_slots_request_idx` ON `request_slots` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `request_slots_held_slot_unique` ON `request_slots` (`availability_slot_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `resident_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`resident_user_id` text NOT NULL,
	`house_or_flat` text NOT NULL,
	`street_or_block` text,
	`locality` text NOT NULL,
	`landmark` text,
	`latitude_e6` integer,
	`longitude_e6` integer,
	`is_primary` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `resident_addresses_user_idx` ON `resident_addresses` (`resident_user_id`);--> statement-breakpoint
CREATE TABLE `resident_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`onboarding_completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`rating` integer NOT NULL,
	`comment` text,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_booking_author_unique` ON `reviews` (`booking_id`,`author_user_id`);--> statement-breakpoint
CREATE INDEX `reviews_subject_idx` ON `reviews` (`subject_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_user_role_unique` ON `user_roles` (`user_id`,`role`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`mobile_e164` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_signed_in_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_mobile_unique` ON `users` (`mobile_e164`);--> statement-breakpoint
CREATE TABLE `verification_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`helper_user_id` text NOT NULL,
	`document_type` text NOT NULL,
	`r2_object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_at` text,
	`review_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `verification_documents_helper_idx` ON `verification_documents` (`helper_user_id`);