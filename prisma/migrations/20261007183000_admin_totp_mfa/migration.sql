-- AlterTable
ALTER TABLE `AdminUser`
  ADD COLUMN `totpSecret` VARCHAR(191) NULL,
  ADD COLUMN `totpPendingSecret` VARCHAR(191) NULL,
  ADD COLUMN `totpEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `totpBackupHashes` LONGTEXT NULL,
  ADD COLUMN `totpEnrolledAt` DATETIME(3) NULL,
  ADD COLUMN `totpLastUsedAt` DATETIME(3) NULL;
