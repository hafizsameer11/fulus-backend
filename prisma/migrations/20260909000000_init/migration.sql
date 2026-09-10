-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `kycStatus` ENUM('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'NOT_STARTED',
    `kycTier` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    UNIQUE INDEX `User_phone_key`(`phone`),
    INDEX `User_status_idx`(`status`),
    INDEX `User_kycStatus_idx`(`kycStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Wallet` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `isVirtual` BOOLEAN NOT NULL DEFAULT false,
    `available` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `pending` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Wallet_userId_idx`(`userId`),
    UNIQUE INDEX `Wallet_userId_currency_key`(`userId`, `currency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LedgerEntry` (
    `id` VARCHAR(191) NOT NULL,
    `walletId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NULL,
    `type` ENUM('CREDIT', 'DEBIT') NOT NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `balanceAfter` DECIMAL(24, 8) NOT NULL,
    `description` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LedgerEntry_walletId_createdAt_idx`(`walletId`, `createdAt`),
    INDEX `LedgerEntry_transactionId_idx`(`transactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Transaction` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` ENUM('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'SWAP', 'BILL_PAYMENT', 'CARD_FUND', 'CARD_WITHDRAW', 'CRYPTO_BUY', 'CRYPTO_SELL', 'CRYPTO_SEND', 'CRYPTO_RECEIVE', 'ESIM_PURCHASE', 'FEE', 'ADJUSTMENT') NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `amount` DECIMAL(24, 8) NOT NULL,
    `fee` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NULL,
    `providerRef` VARCHAR(191) NULL,
    `description` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Transaction_reference_key`(`reference`),
    UNIQUE INDEX `Transaction_idempotencyKey_key`(`idempotencyKey`),
    INDEX `Transaction_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `Transaction_status_idx`(`status`),
    INDEX `Transaction_provider_providerRef_idx`(`provider`, `providerRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FxRate` (
    `id` VARCHAR(191) NOT NULL,
    `baseCurrency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `quoteCurrency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `midRate` DECIMAL(24, 12) NOT NULL,
    `baseBps` INTEGER NOT NULL DEFAULT 90,
    `tier1Bps` INTEGER NOT NULL DEFAULT 35,
    `tier2Bps` INTEGER NOT NULL DEFAULT 12,
    `tier3Bps` INTEGER NOT NULL DEFAULT 0,
    `overrideRate` DECIMAL(24, 12) NULL,
    `overrideNote` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FxRate_active_idx`(`active`),
    UNIQUE INDEX `FxRate_baseCurrency_quoteCurrency_key`(`baseCurrency`, `quoteCurrency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Swap` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `fromCurrency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `toCurrency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `fromAmount` DECIMAL(24, 8) NOT NULL,
    `toAmount` DECIMAL(24, 8) NOT NULL,
    `rateApplied` DECIMAL(24, 12) NOT NULL,
    `midRate` DECIMAL(24, 12) NOT NULL,
    `spreadBps` INTEGER NOT NULL,
    `fxRateId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'SUCCESS',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Swap_transactionId_key`(`transactionId`),
    INDEX `Swap_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Deposit` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NULL,
    `method` ENUM('BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'CRYPTO', 'MANUAL') NOT NULL DEFAULT 'VIRTUAL_ACCOUNT',
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL,
    `amount` DECIMAL(24, 8) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `provider` VARCHAR(191) NULL,
    `providerRef` VARCHAR(191) NULL,
    `instructions` JSON NULL,
    `metadata` JSON NULL,
    `confirmedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Deposit_transactionId_key`(`transactionId`),
    INDEX `Deposit_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `Deposit_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VirtualAccount` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL DEFAULT 'NGN',
    `provider` VARCHAR(191) NOT NULL DEFAULT 'fulus',
    `accountName` VARCHAR(191) NOT NULL,
    `accountNumber` VARCHAR(191) NOT NULL,
    `bankName` VARCHAR(191) NULL,
    `bankCode` VARCHAR(191) NULL,
    `providerRef` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `VirtualAccount_accountNumber_idx`(`accountNumber`),
    UNIQUE INDEX `VirtualAccount_userId_currency_provider_key`(`userId`, `currency`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Beneficiary` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` ENUM('BANK', 'CRYPTO', 'BILLER', 'FULUS_USER') NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NULL,
    `accountName` VARCHAR(191) NULL,
    `accountNumber` VARCHAR(191) NULL,
    `bankCode` VARCHAR(191) NULL,
    `bankName` VARCHAR(191) NULL,
    `network` VARCHAR(191) NULL,
    `address` VARCHAR(191) NULL,
    `fulusUserId` VARCHAR(191) NULL,
    `serviceId` VARCHAR(191) NULL,
    `customerRef` VARCHAR(191) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Beneficiary_userId_type_idx`(`userId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BankTransfer` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `beneficiaryId` VARCHAR(191) NULL,
    `currency` ENUM('NGN', 'USD', 'SAR', 'USDT', 'BTC', 'ETH') NOT NULL DEFAULT 'NGN',
    `amount` DECIMAL(24, 8) NOT NULL,
    `fee` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `accountName` VARCHAR(191) NOT NULL,
    `accountNumber` VARCHAR(191) NOT NULL,
    `bankCode` VARCHAR(191) NOT NULL,
    `bankName` VARCHAR(191) NULL,
    `narration` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NULL,
    `providerRef` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `failureReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BankTransfer_transactionId_key`(`transactionId`),
    INDEX `BankTransfer_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillService` (
    `id` VARCHAR(191) NOT NULL,
    `category` ENUM('AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'BETTING', 'EDUCATION', 'OTHER') NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `shortName` VARCHAR(191) NULL,
    `logoKey` VARCHAR(191) NOT NULL,
    `country` VARCHAR(191) NOT NULL DEFAULT 'NG',
    `provider` VARCHAR(191) NOT NULL DEFAULT 'strowallet',
    `providerCode` VARCHAR(191) NOT NULL,
    `accent` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BillService_category_isActive_idx`(`category`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillVariation` (
    `id` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(24, 8) NULL,
    `metadata` JSON NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BillVariation_serviceId_code_key`(`serviceId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KycCheck` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` ENUM('BVN', 'NIN', 'FACE', 'ADDRESS', 'DOCUMENT') NOT NULL,
    `status` ENUM('PENDING', 'PASSED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `provider` VARCHAR(191) NOT NULL DEFAULT 'prembly',
    `providerRef` VARCHAR(191) NULL,
    `input` JSON NULL,
    `result` JSON NULL,
    `failureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `KycCheck_userId_type_idx`(`userId`, `type`),
    INDEX `KycCheck_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Card` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'pagocards',
    `providerCardId` VARCHAR(191) NULL,
    `brand` VARCHAR(191) NOT NULL DEFAULT 'VISA',
    `binHint` VARCHAR(191) NOT NULL DEFAULT '43',
    `last4` VARCHAR(191) NULL,
    `expMonth` INTEGER NULL,
    `expYear` INTEGER NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `status` ENUM('PENDING', 'ACTIVE', 'FROZEN', 'TERMINATED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `label` VARCHAR(191) NULL,
    `balance` DECIMAL(24, 8) NOT NULL DEFAULT 0,
    `providerPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Card_userId_idx`(`userId`),
    INDEX `Card_status_idx`(`status`),
    UNIQUE INDEX `Card_provider_providerCardId_key`(`provider`, `providerCardId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CardFunding` (
    `id` VARCHAR(191) NOT NULL,
    `cardId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `providerRef` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CardFunding_transactionId_key`(`transactionId`),
    INDEX `CardFunding_cardId_idx`(`cardId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CryptoOrder` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `side` ENUM('BUY', 'SELL') NOT NULL,
    `baseCurrency` VARCHAR(191) NOT NULL,
    `quoteCurrency` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `quoteAmount` DECIMAL(24, 8) NULL,
    `rate` DECIMAL(24, 12) NULL,
    `network` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'busha',
    `providerRef` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `providerPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CryptoOrder_transactionId_key`(`transactionId`),
    INDEX `CryptoOrder_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `CryptoOrder_providerRef_idx`(`providerRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillPayment` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `category` ENUM('AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'BETTING', 'EDUCATION', 'OTHER') NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `customerRef` VARCHAR(191) NOT NULL,
    `variationCode` VARCHAR(191) NULL,
    `amount` DECIMAL(24, 8) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'strowallet',
    `providerRef` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `token` VARCHAR(191) NULL,
    `providerPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BillPayment_transactionId_key`(`transactionId`),
    INDEX `BillPayment_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `BillPayment_category_serviceId_idx`(`category`, `serviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Esim` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'esim-go',
    `iccid` VARCHAR(191) NULL,
    `status` ENUM('ORDERED', 'READY', 'INSTALLED', 'DEPLETED', 'EXPIRED', 'FAILED') NOT NULL DEFAULT 'ORDERED',
    `bundleName` VARCHAR(191) NULL,
    `label` VARCHAR(191) NULL,
    `qrCodeUrl` TEXT NULL,
    `activationCode` TEXT NULL,
    `dataRemainingMb` INTEGER NULL,
    `expiresAt` DATETIME(3) NULL,
    `providerPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Esim_iccid_key`(`iccid`),
    INDEX `Esim_userId_idx`(`userId`),
    INDEX `Esim_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EsimOrder` (
    `id` VARCHAR(191) NOT NULL,
    `esimId` VARCHAR(191) NULL,
    `transactionId` VARCHAR(191) NOT NULL,
    `bundleName` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `orderReference` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `providerPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EsimOrder_transactionId_key`(`transactionId`),
    INDEX `EsimOrder_orderReference_idx`(`orderReference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookEvent` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `headers` JSON NULL,
    `processed` BOOLEAN NOT NULL DEFAULT false,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WebhookEvent_provider_processed_idx`(`provider`, `processed`),
    INDEX `WebhookEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Wallet` ADD CONSTRAINT `Wallet_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LedgerEntry` ADD CONSTRAINT `LedgerEntry_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `Wallet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LedgerEntry` ADD CONSTRAINT `LedgerEntry_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Swap` ADD CONSTRAINT `Swap_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Swap` ADD CONSTRAINT `Swap_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Swap` ADD CONSTRAINT `Swap_fxRateId_fkey` FOREIGN KEY (`fxRateId`) REFERENCES `FxRate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deposit` ADD CONSTRAINT `Deposit_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deposit` ADD CONSTRAINT `Deposit_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VirtualAccount` ADD CONSTRAINT `VirtualAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Beneficiary` ADD CONSTRAINT `Beneficiary_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BankTransfer` ADD CONSTRAINT `BankTransfer_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BankTransfer` ADD CONSTRAINT `BankTransfer_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BankTransfer` ADD CONSTRAINT `BankTransfer_beneficiaryId_fkey` FOREIGN KEY (`beneficiaryId`) REFERENCES `Beneficiary`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillVariation` ADD CONSTRAINT `BillVariation_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `BillService`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KycCheck` ADD CONSTRAINT `KycCheck_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Card` ADD CONSTRAINT `Card_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CardFunding` ADD CONSTRAINT `CardFunding_cardId_fkey` FOREIGN KEY (`cardId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CardFunding` ADD CONSTRAINT `CardFunding_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CryptoOrder` ADD CONSTRAINT `CryptoOrder_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CryptoOrder` ADD CONSTRAINT `CryptoOrder_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillPayment` ADD CONSTRAINT `BillPayment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillPayment` ADD CONSTRAINT `BillPayment_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Esim` ADD CONSTRAINT `Esim_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EsimOrder` ADD CONSTRAINT `EsimOrder_esimId_fkey` FOREIGN KEY (`esimId`) REFERENCES `Esim`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EsimOrder` ADD CONSTRAINT `EsimOrder_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `Transaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
