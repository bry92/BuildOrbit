CREATE TABLE `cameraControls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` int NOT NULL,
	`controlType` enum('pan','zoom','rotation','dolly','orbit') NOT NULL,
	`startFrame` int NOT NULL,
	`endFrame` int NOT NULL,
	`intensity` decimal(5,2) NOT NULL DEFAULT '1.0',
	`easing` enum('linear','easeIn','easeOut','easeInOut') NOT NULL DEFAULT 'linear',
	`conditioningData` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cameraControls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `captureReconstructions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`inputVideoUrl` text NOT NULL,
	`inputVideoKey` text NOT NULL,
	`reconstructionData` json,
	`status` enum('processing','complete','failed') NOT NULL DEFAULT 'processing',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `captureReconstructions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` int NOT NULL,
	`status` enum('deploying','processing','complete','failed') NOT NULL DEFAULT 'deploying',
	`progress` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `studioProjects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` text NOT NULL,
	`timelineData` json,
	`motionBrushData` json,
	`cameraPathData` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `studioProjects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `swarmNodes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`nodeId` varchar(255) NOT NULL,
	`gpuModel` text,
	`gpuMemoryGb` int,
	`status` enum('online','offline','training') NOT NULL DEFAULT 'online',
	`lastHeartbeat` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `swarmNodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `swarmNodes_nodeId_unique` UNIQUE(`nodeId`)
);
--> statement-breakpoint
CREATE TABLE `swarmStats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`gpuHoursContributed` decimal(10,2) NOT NULL DEFAULT '0',
	`killTokensEarned` decimal(15,2) NOT NULL DEFAULT '0',
	`lastUpdated` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `swarmStats_id` PRIMARY KEY(`id`),
	CONSTRAINT `swarmStats_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `trainingJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` varchar(255) NOT NULL,
	`modelType` enum('base','lora') NOT NULL DEFAULT 'lora',
	`status` enum('queued','training','complete','failed') NOT NULL DEFAULT 'queued',
	`datasetSize` int,
	`progress` int NOT NULL DEFAULT 0,
	`nodeIds` json,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `trainingJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `trainingJobs_jobId_unique` UNIQUE(`jobId`)
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` text,
	`prompt` text NOT NULL,
	`referenceImageUrl` text,
	`referenceImageKey` text,
	`status` enum('deploying','processing','complete','failed') NOT NULL DEFAULT 'deploying',
	`videoUrl` text,
	`videoKey` text,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `videos_id` PRIMARY KEY(`id`)
);
