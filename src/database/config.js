const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const { inspectSchema, CURRENT_SCHEMA_VERSION } = require("./migrations");

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

function assertDatabaseMode(databasePath = getDatabasePath(), { demoMode = process.env.DEMO_MODE, projectRoot = path.resolve(__dirname, "../..") } = {}) {
  const mode = String(demoMode ?? "false").trim().toLowerCase();
  if (mode !== "true" && mode !== "false") throw new Error("DEMO_MODE должен быть true или false.");
  const resolvedPath = path.resolve(databasePath);
  const expectedDemoPath = normalizeDatabasePath(path.join(projectRoot, "data", "demo.sqlite"));
  const actualPath = normalizeDatabasePath(resolvedPath);
  const isExpectedDemoPath = actualPath === expectedDemoPath;
  if (mode === "true" && !isExpectedDemoPath) throw new Error("Деморежим остановлен: DB_PATH должен указывать на предусмотренную data/demo.sqlite.");
  if (mode === "false" && isExpectedDemoPath) throw new Error("Обычный режим остановлен: DB_PATH указывает на демонстрационную базу.");

  if (!fs.existsSync(resolvedPath)) {
    if (mode === "true") throw new Error("Деморежим остановлен: демонстрационная база не найдена.");
    throw new Error("Обычный режим остановлен: рабочая SQLite-база не найдена по DB_PATH. База не создана; проверьте путь.");
  }
  if (!fs.statSync(resolvedPath).isFile()) throw new Error("Запуск остановлен: DB_PATH не является файлом SQLite.");

  let probe;
  try {
    probe = new Database(resolvedPath, { readonly: true, fileMustExist: true, timeout: 5000 });
    const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    const hasDemoMarker = tables.has("demo_seed_metadata");
    if (mode === "false" && hasDemoMarker) throw new Error("Обычный режим остановлен: в DB_PATH обнаружены служебные метаданные демобазы.");
    if (mode === "true") {
      if (!tables.has("demo_seed_metadata")) throw new Error("Деморежим остановлен: база не содержит ожидаемые служебные метаданные демобазы.");
      const seed = probe.prepare("SELECT seed_name, seed_version, participant_count FROM demo_seed_metadata").all();
      if (seed.length !== 1 || seed[0].seed_name !== "magic-morning-demo" || seed[0].seed_version !== 1 || seed[0].participant_count !== 150) throw new Error("Деморежим остановлен: метаданные демобазы не прошли проверку.");
    }
    let schema;
    try {
      schema = inspectSchema(probe, { allowKnownOptionalColumns: false });
    } catch {
      throw new Error("Запуск остановлен: существующая SQLite-база не соответствует поддерживаемой схеме v11.");
    }
    if (schema.version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`Запуск остановлен: базе нужна схема SQLite v${CURRENT_SCHEMA_VERSION}; обнаружена версия ${schema.version}. Сначала примените и проверьте миграции.`);
    }
  } catch (error) {
    if (error.message?.includes("остановлен:")) throw error;
    throw new Error("Запуск остановлен: тип существующей SQLite-базы нельзя безопасно определить.");
  } finally { probe?.close(); }
  return { type: mode === "true" ? "demo" : "production", exists: true, path: resolvedPath };
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

module.exports = { getDatabasePath, getBackupDirectory, readBackupSettings, normalizeDatabasePath, classifyDatabasePath, assertDatabaseMode };

