-- Persist admin block/unblock for saved beneficiaries (Batch 3 S/N 28).
ALTER TABLE `Beneficiary` ADD COLUMN `blockedAt` DATETIME(3) NULL;
ALTER TABLE `Beneficiary` ADD COLUMN `blockedBy` VARCHAR(191) NULL;
