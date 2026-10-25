const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function getDatabasePath(env = process.env) {
  const fallback = path.resolve(__dirname, "../../data/club.sqlite");
  return env.DB_PATH ? path.resolve(env.DB_PATH) : fallback;
}

function normalizeDatabasePath(filePath) {
  const absolute = path.resolve(filePath);
  let normalized = absolute;
  try { normalized = fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute); }
  catch { normalized = path.normalize(absolute); }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function classifyDatabasePath(databasePath, { demoMode = process.env.DEMO_MODE, projectRoot = path.resolve(__dirname, "../..") } = {}) {
  const resolved = normalizeDatabasePath(databasePath);
  const demoPath = normalizeDatabasePath(path.join(projectRoot, "data", "demo.sqlite"));
  if (String(demoMode).toLowerCase() === "true") {
    if (resolved !== demoPath) throw new Error("Демонстрационный режим настроен на путь, отличный от demo.sqlite; источник не подтверждён.");
    return "demo";
  }
  if (resolved === demoPath) throw new Error("Отказ: demo.sqlite нельзя резервировать как рабочую базу.");
  return "production";
}

function getBackupDirectory(env = process.env) {
  if (env.BACKUP_DIR?.trim()) return path.resolve(env.BACKUP_DIR.trim());
  const base = process.platform === "win32"
    ? (env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : path.join(os.homedir(), ".local", "share");
  return path.join(base, "MagicMorningBot", "backups");
}

function positiveNumber(value, fallback, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function readBackupSettings(env = process.env) {
  return {
    backupDir: getBackupDirectory(env),
    intervalHours: positiveNumber(env.BACKUP_INTERVAL_HOURS, 24, 24 * 365),
    retentionCount: Math.max(1, Math.floor(positiveNumber(env.BACKUP_RETENTION_COUNT, 14, 3650))),
    autoEnabled: !["false", "0", "no", "off"].includes(String(env.BACKUP_AUTO_ENABLED ?? "true").trim().toLowerCase())
  };
}

module.exports = { getDatabasePath, getBackupDirectory, readBackupSettings, normalizeDatabasePath, classifyDatabasePath };

