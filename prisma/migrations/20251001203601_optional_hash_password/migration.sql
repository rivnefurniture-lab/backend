-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "binanceApiKeyEnc" TEXT,
    "binanceApiSecretEnc" TEXT,
    "binanceConnectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "googleId" TEXT
);
INSERT INTO "new_User" ("binanceApiKeyEnc", "binanceApiSecretEnc", "binanceConnectedAt", "country", "createdAt", "email", "googleId", "id", "name", "passwordHash", "phone") SELECT "binanceApiKeyEnc", "binanceApiSecretEnc", "binanceConnectedAt", "country", "createdAt", "email", "googleId", "id", "name", "passwordHash", "phone" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
