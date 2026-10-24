const fs = require("node:fs");
const Database = require("better-sqlite3");
const { getDatabasePath, readBackupSettings } = require("./config");
const { createBackupManager } = require("./backup");

async function createBackupFromDatabaseFile({
  databasePath = getDatabasePath(),
  backupDir = readBackupSettings().backupDir,
  retentionCount = readBackupSettings().retentionCount,
  DatabaseConstructor = Database
} = {}) {
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    const error = new Error("Рабочая SQLite-база не найдена. Проверьте DB_PATH и наличие файла базы.");
    error.name = "SourceDatabaseNotFoundError";
    error.code = "SOURCE_DB_NOT_FOUND";
    throw error;
  }
  const sourceDb = new DatabaseConstructor(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const manager = createBackupManager({ sourceDb, sourcePath: databasePath, backupDir, retentionCount });
    return await manager.createBackup();
  } finally {
    sourceDb.close();
  }
}

async function main() {
  require("dotenv").config();
  const settings = readBackupSettings();
  try {
    const result = await createBackupFromDatabaseFile({ backupDir: settings.backupDir, retentionCount: settings.retentionCount });
    console.log(`Резервная копия создана и проверена: ${result.path}`);
  } catch (error) {
    if (error?.code === "SOURCE_DB_NOT_FOUND") {
      console.error("Ошибка: рабочая SQLite-база не найдена. Проверьте DB_PATH и наличие файла базы.");
    } else {
      const { safeBackupError } = require("./backup");
      console.error(`Не удалось создать резервную копию: ${JSON.stringify(safeBackupError(error))}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { createBackupFromDatabaseFile };

