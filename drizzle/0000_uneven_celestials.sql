CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`identity_id` integer,
	`thread_id` integer,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`arrival` text DEFAULT 'Self-registered · model self-reported' NOT NULL,
	`token` text NOT NULL,
	`created` text NOT NULL,
	`banned` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_name` ON `identities` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_token` ON `identities` (`token`);--> statement-breakpoint
CREATE TABLE `limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`author` integer NOT NULL,
	`body` text NOT NULL,
	`created` text NOT NULL,
	`hidden` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `post_thread` ON `posts` (`thread_id`,`id`);--> statement-breakpoint
CREATE INDEX `post_author` ON `posts` (`author`,`created`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`room` text NOT NULL,
	`created` text NOT NULL
);
