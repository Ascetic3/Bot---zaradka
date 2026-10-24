const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { inspectSchema, CURRENT_SCHEMA_VERSION } = require("./migrations");
const { normalizeDatabasePath } = require("./config");

const requiredTables = ["participants", "accounts", "admins", "registration_drafts"];
const managedFilename = /^magic-morning-(\d{8}T\d{6}\.\d{3}Z)-([0-9a-f-]{36})\.sqlite$/i;
const metadataKeys = ["created_at", "schema_version", "source_type", "file_size_bytes", "sha256", "participants_count", "accounts_count", "admins_count"];
const hardLinkUnavailableCodes = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

function copyFileExclusive(sourcePath, destinationPath, mode = 0o600) {
  const sourceFd = fs.openSync(sourcePath, "r");
  let destinationFd;
  try {
    destinationFd = fs.openSync(destinationPath, "wx", mode);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let bytesRead;
    while ((bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, position)) > 0) {
      let written = 0;
      while (written < bytesRead) {
        const count = fs.writeSync(destinationFd, buffer, written, bytesRead - written, position + written);
        if (count === 0) throw new Error("Не удалось полностью записать временную копию SQLite.");
        written += count;
      }
      position += bytesRead;
    }
    fs.fsyncSync(destinationFd);
    fs.closeSync(destinationFd);
    destinationFd = undefined;
  } catch (error) {
    if (destinationFd !== undefined) {
      try { fs.closeSync(destinationFd); } catch {}
      destinationFd = undefined;
      try { fs.unlinkSync(destinationPath); } catch {}
    }
    throw error;
  } finally {
    try { fs.closeSync(sourceFd); } catch {}
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
  }
}

function installFileNoOverwrite(sourcePath, destinationPath, mode = 0o600) {
  try {
    fs.linkSync(sourcePath, destinationPath);
    return "hardlink";
  } catch (error) {
    if (!hardLinkUnavailableCodes.has(error?.code)) throw error;
    // Some Windows policies and filesystems prohibit hard links. Fall back to
    // an exclusive, flushed copy; an existing destination is never replaced.
    copyFileExclusive(sourcePath, destinationPath, mode);
    return "copy";
  }
}

class BackupInProgressError extends Error {
  constructor() { super("A backup is already in progress"); this.name = "BackupInProgressError"; this.code = "BACKUP_IN_PROGRESS"; }
}

function rowCounts(db) {
  return {
    participants_count: db.prepare("SELECT COUNT(*) AS count FROM participants").get().count,
    accounts_count: db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count,
    admins_count: db.prepare("SELECT COUNT(*) AS count FROM admins").get().count
  };
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function readManifest(filePath) {
  const manifestPath = `${filePath}.json`;
  if (!fs.existsSync(manifestPath)) throw new Error("У резервной копии отсутствуют технические метаданные.");
  const metadata = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!metadata || Object.keys(metadata).sort().join("|") !== [...metadataKeys].sort().join("|") ||
      !Number.isFinite(Date.parse(metadata.created_at)) || !Number.isInteger(metadata.schema_version) || metadata.schema_version < 0 || metadata.schema_version > CURRENT_SCHEMA_VERSION ||
      !["production", "demo"].includes(metadata.source_type) || !Number.isSafeInteger(metadata.file_size_bytes) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      ![metadata.participants_count, metadata.accounts_count, metadata.admins_count].every(Number.isSafeInteger)) {
    throw new Error("Метаданные резервной копии имеют неизвестный формат.");
  }
  return metadata;
}

function inspectBackupFile(filePath, { requireMetadata = false, expectedMetadata = null } = {}) {
  const checkDb = new Database(filePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const checkRows = checkDb.prepare("PRAGMA integrity_check").all();
    if (checkRows.length !== 1 || checkRows[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    if (checkDb.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite foreign key check failed");
    const schema = inspectSchema(checkDb);
    if (schema.empty) throw new Error("Резервная копия не содержит схему приложения.");
    const names = new Set(checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!requiredTables.every((table) => names.has(table))) throw new Error("Required SQLite tables are missing");
    const counts = rowCounts(checkDb);
    const metadata = expectedMetadata || (requireMetadata ? readManifest(filePath) : null);
    if (metadata) {
      if (metadata.schema_version !== schema.version || metadata.file_size_bytes !== fs.statSync(filePath).size || metadata.sha256 !== hashFile(filePath)) throw new Error("Контрольная сумма, размер или версия схемы резервной копии не совпадают.");
      for (const key of ["participants_count", "accounts_count", "admins_count"]) if (metadata[key] !== counts[key]) throw new Error("Количество записей не совпадает с метаданными резервной копии.");
    }
    return { schemaVersion: schema.version, counts, metadata };
  } finally { checkDb.close(); }
}
function verifyBackupFile(filePath, options = {}) { inspectBackupFile(filePath, options); return true; }

function timestampForFilename(date) { return date.toISOString().replace(/[-:]/g, ""); }
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
  do { filename = `magic-morning-${stamp}-${crypto.randomUUID()}.sqlite`; }
  while (fs.existsSync(path.join(backupDir, filename)) || fs.existsSync(path.join(backupDir, `${filename}.json`)) || fs.existsSync(path.join(backupDir, `${filename}.partial`)) || fs.existsSync(path.join(backupDir, `${filename}.json.partial`)));
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
      verifyBackupFile(filePath, { requireMetadata: true });
      healthy.push({ filePath, metadataPath: `${filePath}.json`, filename, createdAt });
    } catch { /* Повреждённые и чужие файлы не считаются исправными и не удаляются. */ }
  }
  healthy.sort((a, b) => b.createdAt - a.createdAt || b.filename.localeCompare(a.filename));
  const keepCount = Math.max(1, retentionCount);
  const stale = healthy.slice(keepCount).filter((copy) => copy.filePath !== currentPath);
  let removed = 0;
  for (const copy of stale) {
    try {
      fs.unlinkSync(copy.filePath);
      try { fs.unlinkSync(copy.metadataPath); } catch { /* База уже удалена; sidecar остаётся безопасными метаданными. */ }
      removed += 1;
    } catch { /* Неудачная очистка не отменяет проверенную новую копию. */ }
  }
  return { healthyCount: healthy.length, removedCount: removed };
}

function assertSourceIdentity(sourceDb, sourcePath, sourceType, projectRoot) {
  if (!new Set(["production", "demo"]).has(sourceType)) throw new Error("Не удалось определить тип базы-источника.");
  const expected = normalizeDatabasePath(sourcePath);
  const demoPath = normalizeDatabasePath(path.join(projectRoot, "data", "demo.sqlite"));
  if (sourceType === "production" && expected === demoPath) throw new Error("Отказ: демонстрационная база не может быть обработана как рабочая.");
  if (sourceType === "demo" && expected !== demoPath) throw new Error("Демонстрационный режим указывает на неожиданный путь базы.");
  if (typeof sourceDb.pragma === "function") {
    const main = sourceDb.pragma("database_list").find((row) => row.name === "main");
    if (!main?.file || normalizeDatabasePath(main.file) !== expected) throw new Error("Фактически открытый SQLite-файл не совпадает с ожидаемым источником.");
  }
}

function createBackupManager({ sourceDb, sourcePath, backupDir, retentionCount = 14, sourceType = "production", projectRoot = path.resolve(__dirname, "../.."), now = () => new Date() }) {
  if (!sourceDb || typeof sourceDb.backup !== "function") throw new TypeError("sourceDb must provide better-sqlite3 backup()");
  if (!sourcePath) throw new TypeError("sourcePath is required");
  if (!backupDir) throw new TypeError("backupDir is required");
  const safeRetention = Math.max(1, Math.floor(Number(retentionCount) || 14));
  let inFlight = null;

  async function performBackup() {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      const error = new Error("The configured SQLite database file does not exist");
      error.name = "SourceDatabaseNotFoundError"; error.code = "SOURCE_DB_NOT_FOUND"; throw error;
    }
    assertSourceIdentity(sourceDb, sourcePath, sourceType, projectRoot);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const createdAt = now();
    const filename = makeBackupFilename(createdAt, backupDir);
    const finalPath = path.join(backupDir, filename);
    const partialPath = `${finalPath}.partial`;
    const finalManifest = `${finalPath}.json`;
    const partialManifest = `${finalManifest}.partial`;
    let finalCreated = false;
    let manifestCreated = false;
    try {
      await sourceDb.backup(partialPath);
      const snapshot = inspectBackupFile(partialPath);
      const metadata = {
        created_at: createdAt.toISOString(),
        schema_version: snapshot.schemaVersion,
        source_type: sourceType,
        file_size_bytes: fs.statSync(partialPath).size,
        sha256: hashFile(partialPath),
        ...snapshot.counts
      };
      fs.writeFileSync(partialManifest, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      // Prefer an atomic hard link. If the filesystem/OS denies hard links,
      // use an exclusive flushed copy; either path refuses to overwrite.
      installFileNoOverwrite(partialPath, finalPath, 0o600);
      finalCreated = true;
      fs.unlinkSync(partialPath);
      installFileNoOverwrite(partialManifest, finalManifest, 0o600);
      manifestCreated = true;
      fs.unlinkSync(partialManifest);
      verifyBackupFile(finalPath, { requireMetadata: true });
    } catch (error) {
      for (const candidate of [partialPath, partialManifest, ...(finalCreated ? [finalPath] : []), ...(manifestCreated ? [finalManifest] : [])]) {
        try { fs.unlinkSync(candidate); } catch { /* Удаляем только уникальные пути, созданные этой операцией. */ }
      }
      throw error;
    }
    let retention = { healthyCount: 1, removedCount: 0, cleanupSkipped: false };
    try { retention = cleanupOldBackups(backupDir, safeRetention, finalPath); }
    catch { retention.cleanupSkipped = true; }
    return { path: finalPath, metadataPath: finalManifest, filename, createdAt: createdAt.toISOString(), verified: true, metadata: readManifest(finalPath), retention };
  }

  function createBackup() {
    if (inFlight) return inFlight;
    inFlight = performBackup().finally(() => { inFlight = null; });
    return inFlight;
  }
  return { createBackup };
}

function restoreBackup(backupPath, destinationPath) {
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (normalizeDatabasePath(source) === normalizeDatabasePath(destination)) throw new Error("Путь восстановления совпадает с резервной копией.");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Резервная копия не найдена.");
  if (fs.existsSync(destination) || fs.existsSync(`${destination}.json`)) throw new Error("Путь восстановления уже занят; существующие файлы оставлены без изменений.");
  verifyBackupFile(source, { requireMetadata: true });
  const metadata = readManifest(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.partial`;
  let temporaryCreated = false;
  let destinationCreated = false;
  let manifestCreated = false;
  try {
    copyFileExclusive(source, temporary, 0o600);
    temporaryCreated = true;
    verifyBackupFile(temporary, { expectedMetadata: metadata });
    installFileNoOverwrite(temporary, destination, 0o600);
    destinationCreated = true;
    fs.unlinkSync(temporary);
    const manifestFd = fs.openSync(`${destination}.json`, "wx", 0o600);
    manifestCreated = true;
    try {
      fs.writeFileSync(manifestFd, `${JSON.stringify(metadata, null, 2)}\n`);
      fs.fsyncSync(manifestFd);
    } finally { fs.closeSync(manifestFd); }
    verifyBackupFile(destination, { requireMetadata: true });
    return { path: destination, metadataPath: `${destination}.json`, verified: true, metadata };
  } catch (error) {
    for (const candidate of [...(temporaryCreated ? [temporary] : []), ...(destinationCreated ? [destination] : []), ...(manifestCreated ? [`${destination}.json`] : [])]) {
      try { fs.unlinkSync(candidate); } catch { /* Удаляется только созданный функцией путь восстановления. */ }
    }
    throw error;
  }
}

function safeBackupError(error) {
  const name = new Set(["Error", "TypeError", "RangeError", "SqliteError", "BackupInProgressError", "SourceDatabaseNotFoundError"]).has(error?.name) ? error.name : "Error";
  const result = { event: "sqlite_backup_failed", error_type: name };
  if (typeof error?.code === "string" && /^[A-Z0-9_]{1,48}$/.test(error.code)) result.error_code = error.code;
  return result;
}

function startAutomaticBackups(manager, { enabled = true, intervalMs = 24 * 60 * 60 * 1000, logger = console, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!enabled) {
    const noop = () => Promise.resolve();
    noop.waitForIdle = noop;
    return noop;
  }
  let stopped = false;
  let activeRun = null;
  const run = () => {
    if (stopped || activeRun) return activeRun;
    // Keep a handle to the active copy so graceful shutdown can wait before closing SQLite.
    try {
      activeRun = Promise.resolve(manager.createBackup()).then(() => {
        logger.info?.(JSON.stringify({ event: "sqlite_backup_created" }));
      }).catch((error) => {
        logger.error?.(JSON.stringify(safeBackupError(error)));
      }).finally(() => { activeRun = null; });
    } catch (error) {
      logger.error?.(JSON.stringify(safeBackupError(error)));
      activeRun = Promise.resolve();
    }
    return activeRun;
  };
  run();
  const timer = setIntervalFn(run, intervalMs);
  timer?.unref?.();
  const stop = () => {
    stopped = true;
    clearIntervalFn(timer);
    return stop.waitForIdle();
  };
  stop.waitForIdle = () => activeRun || Promise.resolve();
  return stop;
}

module.exports = { createBackupManager, verifyBackupFile, restoreBackup, cleanupOldBackups, startAutomaticBackups, safeBackupError, BackupInProgressError, requiredTables, hashFile, readManifest, inspectBackupFile };
