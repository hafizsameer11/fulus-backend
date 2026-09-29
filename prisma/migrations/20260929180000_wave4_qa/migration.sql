-- Wave 4: sessions, security, referrals, support, kill switches

ALTER TABLE `User` ADD COLUMN `tokenVersion` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `User` ADD COLUMN `referralCode` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `User_referralCode_key` ON `User`(`referralCode`);

ALTER TABLE `RefreshToken` ADD COLUMN `deviceLabel` VARCHAR(191) NULL;
ALTER TABLE `RefreshToken` ADD COLUMN `userAgent` TEXT NULL;
ALTER TABLE `RefreshToken` ADD COLUMN `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE TABLE `UserSecuritySettings` (
    `userId` VARCHAR(191) NOT NULL,
    `transactionPinHash` VARCHAR(191) NULL,
    `transactionPinEnabled` BOOLEAN NOT NULL DEFAULT false,
    `biometricEnabled` BOOLEAN NOT NULL DEFAULT false,
    `cryptoWhitelistOnly` BOOLEAN NOT NULL DEFAULT false,
    `cryptoWithdrawalLockHours` INTEGER NOT NULL DEFAULT 0,
    `cryptoAntiPhishingCode` VARCHAR(191) NULL,
    `cryptoSecurityUpdatedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ClosureRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'PROCESSED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ClosureRequest_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `ClosureRequest_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReferralAttribution` (
    `id` VARCHAR(191) NOT NULL,
    `referrerUserId` VARCHAR(191) NOT NULL,
    `referredUserId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `rewardAmount` DECIMAL(24, 8) NOT NULL,
    `status` ENUM('PENDING', 'QUALIFIED', 'REWARDED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReferralAttribution_referredUserId_key`(`referredUserId`),
    INDEX `ReferralAttribution_referrerUserId_createdAt_idx`(`referrerUserId`, `createdAt`),
    INDEX `ReferralAttribution_code_idx`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SupportTicket` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SupportTicket_userId_updatedAt_idx`(`userId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SupportMessage` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `senderRole` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SupportMessage_ticketId_createdAt_idx`(`ticketId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PlatformConfig` (
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UserSecuritySettings` ADD CONSTRAINT `UserSecuritySettings_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ClosureRequest` ADD CONSTRAINT `ClosureRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ReferralAttribution` ADD CONSTRAINT `ReferralAttribution_referrerUserId_fkey` FOREIGN KEY (`referrerUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ReferralAttribution` ADD CONSTRAINT `ReferralAttribution_referredUserId_fkey` FOREIGN KEY (`referredUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SupportTicket` ADD CONSTRAINT `SupportTicket_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SupportMessage` ADD CONSTRAINT `SupportMessage_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `SupportTicket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
