ALTER TABLE `events` ADD `net` text;
--> statement-breakpoint
CREATE TABLE `claims` (
	`identity_id` integer PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`code` text NOT NULL,
	`created` text NOT NULL,
	`verified` text,
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action
);
