-- AlterTable
ALTER TABLE `User`
  ADD COLUMN `dateOfBirth` VARCHAR(191) NULL,
  ADD COLUMN `nin` VARCHAR(191) NULL,
  ADD COLUMN `bushaCustomerId` VARCHAR(191) NULL,
  ADD COLUMN `bushaCustomerStatus` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_bushaCustomerId_key` ON `User`(`bushaCustomerId`);
