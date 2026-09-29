-- AlterTable
ALTER TABLE `User` ADD COLUMN `username` VARCHAR(191) NULL,
    ADD COLUMN `country` VARCHAR(191) NULL,
    ADD COLUMN `bvn` VARCHAR(191) NULL,
    ADD COLUMN `riskScore` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `ltv` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `signupSource` VARCHAR(191) NULL,
    ADD COLUMN `flagsJson` JSON NULL,
    ADD COLUMN `lastActiveAt` DATETIME(3) NULL;

-- AlterEnum (MySQL): add values by modifying column — Prisma uses ENUM
-- UserStatus may need ALTER; apply safely
ALTER TABLE `User` MODIFY `status` ENUM('ACTIVE', 'RESTRICTED', 'FROZEN', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'ACTIVE';

CREATE UNIQUE INDEX `User_username_key` ON `User`(`username`);
CREATE INDEX `User_country_idx` ON `User`(`country`);
CREATE INDEX `User_riskScore_idx` ON `User`(`riskScore`);
CREATE INDEX `User_lastActiveAt_idx` ON `User`(`lastActiveAt`);

CREATE TABLE `AdminIncident` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `rail` VARCHAR(191) NOT NULL DEFAULT '',
    `commander` VARCHAR(191) NOT NULL DEFAULT '',
    `timeline` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX `AdminIncident_status_idx` ON `AdminIncident`(`status`);
CREATE INDEX `AdminIncident_createdAt_idx` ON `AdminIncident`(`createdAt`);

CREATE TABLE `CustomerSegment` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `rules` JSON NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `usedBy` JSON NULL,
    `sizeCache` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Dispute` (
    `id` VARCHAR(191) NOT NULL,
    `caseRef` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NULL,
    `stage` VARCHAR(191) NOT NULL DEFAULT 'intake',
    `rail` VARCHAR(191) NOT NULL,
    `reasonCode` VARCHAR(191) NOT NULL,
    `reasonLabel` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `feeNgn` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `provisionalCredit` BOOLEAN NOT NULL DEFAULT false,
    `liability` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `merchant` VARCHAR(191) NOT NULL DEFAULT '',
    `network` VARCHAR(191) NOT NULL DEFAULT '',
    `owner` VARCHAR(191) NOT NULL DEFAULT '',
    `priority` VARCHAR(191) NOT NULL DEFAULT 'normal',
    `winProbability` INTEGER NOT NULL DEFAULT 50,
    `notes` TEXT NULL,
    `evidence` JSON NULL,
    `timeline` JSON NULL,
    `deadlineAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `Dispute_caseRef_key`(`caseRef`),
    INDEX `Dispute_userId_openedAt_idx`(`userId`, `openedAt`),
    INDEX `Dispute_stage_idx`(`stage`),
    INDEX `Dispute_rail_idx`(`rail`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Refund` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NULL,
    `disputeId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'requested',
    `origin` VARCHAR(191) NOT NULL DEFAULT 'support',
    `reason` VARCHAR(191) NOT NULL,
    `rail` VARCHAR(191) NOT NULL,
    `method` VARCHAR(191) NOT NULL DEFAULT 'wallet_credit',
    `originalAmount` DECIMAL(24, 8) NOT NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `feeRefunded` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `partial` BOOLEAN NOT NULL DEFAULT false,
    `requestedBy` VARCHAR(191) NOT NULL,
    `approver` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'fulus',
    `providerRef` VARCHAR(191) NULL,
    `autoApproved` BOOLEAN NOT NULL DEFAULT false,
    `recoverable` BOOLEAN NOT NULL DEFAULT true,
    `recoveredFrom` VARCHAR(191) NULL,
    `slaHours` INTEGER NOT NULL DEFAULT 24,
    `timeline` JSON NULL,
    `note` TEXT NULL,
    `failureReason` VARCHAR(191) NULL,
    `dueAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `Refund_userId_requestedAt_idx`(`userId`, `requestedAt`),
    INDEX `Refund_status_idx`(`status`),
    INDEX `Refund_rail_idx`(`rail`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RefundPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `rail` VARCHAR(191) NOT NULL,
    `rules` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BankStatementLine` (
    `id` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `bank` VARCHAR(191) NOT NULL,
    `narration` TEXT NOT NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL DEFAULT 'NGN',
    `matched` BOOLEAN NOT NULL DEFAULT false,
    `matchedDepositId` VARCHAR(191) NULL,
    `suggestion` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `BankStatementLine_matched_idx`(`matched`),
    INDEX `BankStatementLine_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PayoutBatch` (
    `id` VARCHAR(191) NOT NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `rail` VARCHAR(191) NOT NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `total` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `succeeded` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'awaiting_approval',
    `approver` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `PayoutBatch_status_idx`(`status`),
    INDEX `PayoutBatch_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AdminAuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NULL,
    `detail` TEXT NOT NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `AdminAuditLog_subjectId_createdAt_idx`(`subjectId`, `createdAt`),
    INDEX `AdminAuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `FxRateChange` (
    `id` VARCHAR(191) NOT NULL,
    `corridor` VARCHAR(191) NOT NULL,
    `field` VARCHAR(191) NOT NULL,
    `fromValue` VARCHAR(191) NOT NULL,
    `toValue` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `approver` VARCHAR(191) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `FxRateChange_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Dispute` ADD CONSTRAINT `Dispute_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AdminAuditLog` ADD CONSTRAINT `AdminAuditLog_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
