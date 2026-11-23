CREATE TABLE `alert_sends` (
	`watch_id` integer NOT NULL,
	`event_key` text NOT NULL,
	`sent_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`watch_id`, `event_key`),
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `watches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`min_lon` real NOT NULL,
	`min_lat` real NOT NULL,
	`max_lon` real NOT NULL,
	`max_lat` real NOT NULL,
	`unsubscribe_token` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watches_unsubscribe_token_unique` ON `watches` (`unsubscribe_token`);--> statement-breakpoint
CREATE INDEX `watches_email_idx` ON `watches` (`email`);