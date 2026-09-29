-- AlterTable / CreateTable for admin console remaining modules

CREATE TABLE `AmlAlert` (
    `id` VARCHAR(191) NOT NULL,
    `ruleId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `customerName` VARCHAR(191) NOT NULL DEFAULT '',
    `score` INTEGER NOT NULL DEFAULT 0,
    `valueUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `assignee` VARCHAR(191) NOT NULL DEFAULT '',
    `narrative` TEXT NOT NULL,
    `legs` JSON NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AmlAlert_status_openedAt_idx`(`status`, `openedAt`),
    INDEX `AmlAlert_userId_idx`(`userId`),
    INDEX `AmlAlert_ruleId_idx`(`ruleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SanctionHit` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `subject` VARCHAR(191) NOT NULL,
    `matchedName` VARCHAR(191) NOT NULL,
    `list` VARCHAR(191) NOT NULL,
    `matchScore` INTEGER NOT NULL,
    `dobDelta` VARCHAR(191) NOT NULL DEFAULT '',
    `country` VARCHAR(191) NOT NULL DEFAULT '',
    `program` VARCHAR(191) NOT NULL DEFAULT '',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `maker` VARCHAR(191) NOT NULL DEFAULT '',
    `checker` VARCHAR(191) NOT NULL DEFAULT '',
    `context` TEXT NOT NULL,
    `screenedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SanctionHit_status_screenedAt_idx`(`status`, `screenedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ComplianceCase` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL DEFAULT 'medium',
    `stage` VARCHAR(191) NOT NULL DEFAULT 'intake',
    `userId` VARCHAR(191) NULL,
    `subject` VARCHAR(191) NOT NULL DEFAULT '',
    `assignee` VARCHAR(191) NOT NULL DEFAULT '',
    `exposureUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `linkedAlerts` JSON NULL,
    `evidence` JSON NULL,
    `narrative` TEXT NOT NULL,
    `sarRef` VARCHAR(191) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `dueAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ComplianceCase_stage_openedAt_idx`(`stage`, `openedAt`),
    INDEX `ComplianceCase_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RegReport` (
    `id` VARCHAR(191) NOT NULL,
    `regulator` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `cadence` VARCHAR(191) NOT NULL,
    `period` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `dueAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `ref` VARCHAR(191) NULL,
    `rows` INTEGER NOT NULL DEFAULT 0,
    `retention` VARCHAR(191) NOT NULL DEFAULT '7y',
    `owner` VARCHAR(191) NOT NULL DEFAULT '',
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RegReport_regulator_status_idx`(`regulator`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DsrRequest` (
    `id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `subject` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `legalHold` BOOLEAN NOT NULL DEFAULT false,
    `holdReason` VARCHAR(191) NULL,
    `channel` VARCHAR(191) NOT NULL DEFAULT 'email',
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `dueAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DsrRequest_status_dueAt_idx`(`status`, `dueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CardProgram` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `network` VARCHAR(191) NOT NULL,
    `processor` VARCHAR(191) NOT NULL DEFAULT '',
    `bin` VARCHAR(191) NOT NULL DEFAULT '',
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `formFactor` VARCHAR(191) NOT NULL DEFAULT 'virtual',
    `issuanceFeeUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `monthlyFeeUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `fxMarkupPct` DECIMAL(8, 4) NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'live',
    `cardsIssued` INTEGER NOT NULL DEFAULT 0,
    `activeCards` INTEGER NOT NULL DEFAULT 0,
    `spend30dUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `approvalRate` DECIMAL(8, 4) NOT NULL DEFAULT 0,
    `bufferUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `countries` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CardAuthorization` (
    `id` VARCHAR(191) NOT NULL,
    `cardId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NULL,
    `last4` VARCHAR(191) NOT NULL DEFAULT '',
    `customerName` VARCHAR(191) NOT NULL DEFAULT '',
    `merchant` VARCHAR(191) NOT NULL,
    `mcc` VARCHAR(191) NOT NULL DEFAULT '',
    `mccLabel` VARCHAR(191) NOT NULL DEFAULT '',
    `country` VARCHAR(191) NOT NULL DEFAULT '',
    `amount` DECIMAL(24, 8) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `billingAmount` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `fxRate` DECIMAL(24, 12) NOT NULL DEFAULT 1,
    `decision` VARCHAR(191) NOT NULL DEFAULT 'approved',
    `declineCode` VARCHAR(191) NULL,
    `threeDs` BOOLEAN NOT NULL DEFAULT false,
    `networkRef` VARCHAR(191) NULL,
    `latencyMs` INTEGER NOT NULL DEFAULT 0,
    `riskScore` INTEGER NOT NULL DEFAULT 0,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CardAuthorization_at_idx`(`at`),
    INDEX `CardAuthorization_decision_at_idx`(`decision`, `at`),
    INDEX `CardAuthorization_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `EngagementCampaign` (
    `id` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EngagementCampaign_channel_status_idx`(`channel`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CryptoNetworkPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `short` VARCHAR(191) NOT NULL DEFAULT '',
    `assets` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'healthy',
    `depositsEnabled` BOOLEAN NOT NULL DEFAULT true,
    `withdrawalsEnabled` BOOLEAN NOT NULL DEFAULT true,
    `confirmations` INTEGER NOT NULL DEFAULT 1,
    `avgBlockSec` INTEGER NOT NULL DEFAULT 0,
    `medianConfirmMin` DECIMAL(12, 4) NOT NULL DEFAULT 0,
    `networkFeeUsd` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `feePolicy` VARCHAR(191) NOT NULL DEFAULT 'customer',
    `pendingDeposits` INTEGER NOT NULL DEFAULT 0,
    `pendingWithdrawals` INTEGER NOT NULL DEFAULT 0,
    `notice` TEXT NULL,
    `explorer` VARCHAR(191) NOT NULL DEFAULT '',
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CryptoExposure` (
    `asset` VARCHAR(191) NOT NULL,
    `netPositionCoin` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `netPositionUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `limitUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `hedgeRatio` DECIMAL(8, 4) NOT NULL DEFAULT 0,
    `pnl24hUsd` DECIMAL(24, 2) NOT NULL DEFAULT 0,
    `autoHalt` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`asset`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
