const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const requiredTables = ["participants", "accounts", "admins", "registration_drafts"];
const managedFilename = /^magic-morning-(\d{8}T\d{6}\.\d{3}Z)-([0-9a-f-]{36})\.sqlite$/i;

class BackupInProgressError extends Error {
  constructor() {
    super("A backup is already in progress");
    this.name = "BackupInProgressError";
    this.code = "BACKUP_IN_PROGRESS";
  }
}

function verifyBackupFile(filePath) {
  const checkDb = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const checkRows = checkDb.prepare("PRAGMA integrity_check").all();
    if (checkRows.length !== 1 || checkRows[0].integrity_check !== "ok") {
      throw new Error("SQLite integrity check failed");
    }
    const tables = new Set(checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const missing = requiredTables.filter((table) => !tables.has(table));
    if (missing.length) throw new Error("Required SQLite tables are missing");
    return true;
  } finally {
    checkDb.close();
  }
}

function timestampForFilename(date) {
  return date.toISOString().replace(/[-:]/g, "");
}

function parseManagedDate(filename) {
  const match = filename.match(managedFilename);
  if (!match) return null;
  const compact = match[1];
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}.${compact.slice(16, 19)}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

function makeBackupFilename(date, backupDir) {
  const stamp = timestampForFilename(date);
  let filename;
  do {
    filename = `magic-morning-${stamp}-${crypto.randomUUID()}.sqlite`;
  } while (fs.existsSync(path.join(backupDir, filename)));
  return filename;
}

function cleanupOldBackups(backupDir, retentionCount, currentPath) {
  const healthy = [];
  for (const filename of fs.readdirSync(backupDir)) {
    const createdAt = parseManagedDate(filename);
    if (createdAt === null) continue;
    const filePath = path.join(backupDir, filename);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      verifyBackupFile(filePath);
      healthy.push({ filePath, filename, createdAt });
    } catch {
      // Неизвестные и повреждённые файлы не считаются исправными копиями.
      // Их не удаляем: очистка трогает только подтверждённые исправные копии.
    }
  }
  healthy.sort((a, b) => b.createdAt - a.createdAt || b.filename.localeCompare(a.filename));
  const keepCount = Math.max(1, retentionCount);
  const stale = healthy.slice(keepCount).filter((copy) => copy.filePath !== currentPath);
  let removed = 0;
  for (const copy of stale) {
    try {
      fs.unlinkSync(copy.filePath);
      removed += 1;
    } catch {
      // Неудачная очистка не отменяет уже проверенную новую резервную копию.
    }
  }
  return { healthyCount: healthy.length, removedCount: removed };
}

function createBackupManager({ sourceDb, sourcePath, backupDir, retentionCount = 14, now = () => new Date() }) {
  if (!sourceDb || typeof sourceDb.backup !== "function") throw new TypeError("sourceDb must provide better-sqlite3 backup()");
  if (!sourcePath) throw new TypeError("sourcePath is required");
  if (!backupDir) throw new TypeError("backupDir is required");
  const safeRetention = Math.max(1, Math.floor(Number(retentionCount) || 14));
  let inFlight = null;

  async function performBackup() {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      const error = new Error("The configured SQLite database file does not exist");
      error.name = "SourceDatabaseNotFoundError";
      error.code = "SOURCE_DB_NOT_FOUND";
      throw error;
    }
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const createdAt = now();
    const filename = makeBackupFilename(createdAt, backupDir);
    const finalPath = path.join(backupDir, filename);
    try {
      await sourceDb.backup(finalPath);
      verifyBackupFile(finalPath);
    } catch (error) {
      // Имя только что сгенерировано и до этой операции не существовало.
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      throw error;
    }
    let retention = { healthyCount: 1, removedCount: 0, cleanupSkipped: false };
    try { retention = cleanupOldBackups(backupDir, safeRetention, finalPath); }
    catch { retention.cleanupSkipped = true; }
    return { path: finalPath, filename, createdAt: createdAt.toISOString(), verified: true, retention };
  }

  function createBackup() {
    // Несколько одновременных запросов одного процесса разделяют одну операцию.
    if (inFlight) return inFlight;
    inFlight = performBackup().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { createBackup };
}

function safeBackupError(error) {
  const name = new Set(["Error", "TypeError", "RangeError", "SqliteError", "BackupInProgressError", "SourceDatabaseNotFoundError"]).has(error?.name)
    ? error.name
    : "Error";
  const result = { event: "sqlite_backup_failed", error_type: name };
  if (typeof error?.code === "string" && /^[A-Z0-9_]{1,48}$/.test(error.code)) result.error_code = error.code;
  return result;
}

function startAutomaticBackups(manager, {
  enabled = true,
  intervalMs = 24 * 60 * 60 * 1000,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (!enabled) return () => {};
  let stopped = false;
  const run = () => {
    if (stopped) return;
    manager.createBackup().then(() => {
      logger.info?.(JSON.stringify({ event: "sqlite_backup_created" }));
    }).catch((error) => {
      logger.error?.(JSON.stringify(safeBackupError(error)));
    });
  };
  run();
  const timer = setIntervalFn(run, intervalMs);
  timer?.unref?.();
  return () => {
    stopped = true;
    clearIntervalFn(timer);
  };
}

module.exports = {
  createBackupManager,
  verifyBackupFile,
  cleanupOldBackups,
  startAutomaticBackups,
  safeBackupError,
  BackupInProgressError,
  requiredTables
};

