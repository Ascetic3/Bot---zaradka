const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const BetterSqlite3 = require("better-sqlite3");
const { createBackupManager, verifyBackupFile, restoreBackup, startAutomaticBackups, requiredTables } = require("../src/database/backup");
const { createBackupFromDatabaseFile } = require("../src/database/backup-cli");
const { readBackupSettings, classifyDatabasePath } = require("../src/database/config");
const { createBaseSchema, migrateDatabase, CURRENT_SCHEMA_VERSION } = require("../src/database/migrations");

function setupDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-backup-test-"));
  const dbPath = path.join(directory, "source.sqlite");
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve("../src/database")];
  const db = require("../src/database");
  const backupDir = path.join(directory, "private-backups");
  function addFakeData() {
    const participant = db.addParticipant({
      first_name: "ТестовоеИмя",
      last_name: "ВымышленнаяФамилия",
      phone: "+79990000001",
      city: "Тестоград",
      email: "synthetic@example.invalid",
      preferred_contact: "Telegram",
      referral_source: "Тестовый источник",
      phone_confirmed_at: "2026-01-01T00:00:00.000Z",
      personal_data_consent: true,
      consent_at: "2026-01-01T00:00:00.000Z"
    }, { platform: "telegram", messenger_user_id: "700000001" });
    db.initializeOwner("700000002");
    db.addAdmin("700000003");
    db.saveDraft("telegram", "700000004", "email", { first_name: "ЧерновоеИмя", email: "draft@example.invalid" });
    return participant;
  }
  return {
    directory, dbPath, backupDir, db, addFakeData,
    manager(options = {}) {
      return createBackupManager({ sourceDb: db.db, sourcePath: dbPath, backupDir, ...options });
    },
    close() {
      try { db.closeDatabase(); } catch {}
      delete process.env.DB_PATH;
      delete require.cache[require.resolve("../src/database")];
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function managedFiles(folder) {
  return fs.readdirSync(folder).filter((name) => /^magic-morning-\d{8}T\d{6}\.\d{3}Z-[0-9a-f-]{36}\.sqlite$/i.test(name));
}

test("создаёт проверенную копию, включая все таблицы, данные, аккаунты, администраторов и черновики", async () => {
  const x = setupDatabase();
  try {
    const participant = x.addFakeData();
    const result = await x.manager().createBackup();
    assert.equal(result.verified, true);
    assert.ok(fs.existsSync(result.path));
    assert.equal(verifyBackupFile(result.path), true);
    assert.equal(result.metadata.schema_version, x.db.schemaVersion);
    assert.equal(result.metadata.source_type, "production");
    assert.equal(result.metadata.participants_count, 1);
    assert.equal(result.metadata.accounts_count, 1);
    assert.equal(result.metadata.admins_count, 2);
    assert.match(result.metadata.sha256, /^[a-f0-9]{64}$/);
    const manifestText = fs.readFileSync(result.metadataPath, "utf8");
    assert.doesNotMatch(manifestText, /ТестовоеИмя|ВымышленнаяФамилия|synthetic@example|700000001|\+79990000001/);
    const copy = new BetterSqlite3(result.path, { readonly: true, fileMustExist: true });
    try {
      const tables = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      for (const table of requiredTables) assert.ok(tables.has(table));
      assert.equal(copy.prepare("SELECT first_name FROM participants WHERE id=?").get(participant.id).first_name, "ТестовоеИмя");
      assert.equal(copy.prepare("SELECT messenger_user_id FROM accounts WHERE participant_id=? AND platform='telegram'").get(participant.id).messenger_user_id, "700000001");
      assert.equal(copy.prepare("SELECT role FROM admins WHERE telegram_id=?").get("700000002").role, "owner");
      assert.equal(copy.prepare("SELECT count(*) AS n FROM admins WHERE role='admin'").get().n, 1);
      assert.equal(copy.prepare("SELECT current_step FROM registration_drafts WHERE messenger_user_id=?").get("700000004").current_step, "email");
    } finally { copy.close(); }
  } finally { x.close(); }
});

test("создаёт согласованную копию, пока исходная SQLite работает в WAL", async () => {
  const x = setupDatabase();
  try {
    assert.equal(x.db.db.pragma("journal_mode", { simple: true }).toLowerCase(), "wal");
    x.addFakeData();
    const result = await x.manager().createBackup();
    const copy = new BetterSqlite3(result.path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(copy.prepare("SELECT count(*) AS n FROM participants").get().n, 1);
      assert.deepEqual(copy.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
    } finally { copy.close(); }
  } finally { x.close(); }
});

test("созданная копия проходит integrity_check и содержит обязательные таблицы", async () => {
  const x = setupDatabase();
  try {
    const result = await x.manager().createBackup();
    assert.equal(verifyBackupFile(result.path), true);
    assert.match(result.filename, /^magic-morning-\d{8}T\d{6}\.\d{3}Z-[0-9a-f-]{36}\.sqlite$/i);
  } finally { x.close(); }
});

test("резервирование и восстановление работают, даже если ОС запрещает жёсткие ссылки", async () => {
  const x = setupDatabase();
  const originalLink = fs.linkSync;
  try {
    const participant = x.addFakeData();
    fs.linkSync = () => { const error = new Error("hard links disabled by test filesystem"); error.code = "EPERM"; throw error; };
    const backup = await x.manager().createBackup();
    assert.equal(verifyBackupFile(backup.path, { requireMetadata: true }), true);
    const destination = path.join(x.directory, "restored.sqlite");
    const restored = restoreBackup(backup.path, destination);
    assert.equal(restored.verified, true);
    const copy = new BetterSqlite3(destination, { readonly: true, fileMustExist: true });
    try {
      assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 1);
      assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 1);
      assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM admins").get().count, 2);
      assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM registration_drafts").get().count, 1);
      assert.equal(copy.prepare("SELECT id FROM participants").get().id, participant.id);
      assert.deepEqual(copy.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
      assert.deepEqual(copy.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { copy.close(); }

    const occupied = path.join(x.directory, "occupied.sqlite");
    fs.writeFileSync(occupied, "keep this unrelated file");
    assert.throws(() => restoreBackup(backup.path, occupied), /уже занят/);
    assert.equal(fs.readFileSync(occupied, "utf8"), "keep this unrelated file");
  } finally {
    fs.linkSync = originalLink;
    x.close();
  }
});

test("команда резервирования отказывается при отсутствии исходного файла и не создаёт пустую базу", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-backup-missing-"));
  const missingPath = path.join(directory, "does-not-exist.sqlite");
  try {
    await assert.rejects(createBackupFromDatabaseFile({ databasePath: missingPath, backupDir: path.join(directory, "backups") }), { code: "SOURCE_DB_NOT_FOUND" });
    assert.equal(fs.existsSync(missingPath), false);
    assert.equal(fs.existsSync(path.join(directory, "backups")), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("ручной CLI-слой создаёт копию только существующей временной базы", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    const result = await createBackupFromDatabaseFile({
      databasePath: x.dbPath,
      backupDir: x.backupDir,
      retentionCount: 14
    });
    assert.equal(result.verified, true);
    assert.equal(verifyBackupFile(result.path), true);
  } finally { x.close(); }
});

test("ошибка записи безопасно возвращается вызывающему коду и оставляет существующие копии", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    const previous = await x.manager().createBackup();
    const failure = new Error("synthetic backup write failure");
    failure.name = "Error";
    const broken = createBackupManager({
      sourceDb: { backup: async () => { throw failure; } },
      sourcePath: x.dbPath,
      backupDir: x.backupDir
    });
    await assert.rejects(broken.createBackup(), /synthetic backup write failure/);
    assert.equal(fs.existsSync(previous.path), true);
    assert.equal(managedFiles(x.backupDir).length, 1);
    assert.equal(fs.readdirSync(x.backupDir).some((name) => name.endsWith(".partial.sqlite")), false);

    const blockedPath = path.join(x.directory, "not-a-folder");
    fs.writeFileSync(blockedPath, "fixture");
    const badDestination = createBackupManager({ sourceDb: x.db.db, sourcePath: x.dbPath, backupDir: blockedPath });
    await assert.rejects(badDestination.createBackup(), { code: "EEXIST" });
    assert.equal(fs.existsSync(previous.path), true);
  } finally { x.close(); }
});

test("одновременные вызовы одного менеджера используют одну операцию backup", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const originalBackup = x.db.db.backup.bind(x.db.db);
    const sourceDb = {
      async backup(destination) {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        try { return await originalBackup(destination); }
        finally { active -= 1; }
      }
    };
    const manager = createBackupManager({ sourceDb, sourcePath: x.dbPath, backupDir: x.backupDir });
    const first = manager.createBackup();
    const second = manager.createBackup();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.path, b.path);
    assert.equal(calls, 1);
    assert.equal(maxActive, 1);
  } finally { x.close(); }
});

test("очистка сохраняет заданное число исправных копий и не удаляет посторонние файлы", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    fs.mkdirSync(x.backupDir, { recursive: true });
    fs.writeFileSync(path.join(x.backupDir, "other.sqlite"), "not managed");
    fs.writeFileSync(path.join(x.backupDir, "notes.txt"), "keep");
    let nowMs = Date.UTC(2026, 0, 1);
    const manager = x.manager({ retentionCount: 2, now: () => new Date(nowMs) });
    for (let index = 0; index < 5; index += 1) {
      await manager.createBackup();
      nowMs += 1000;
    }
    assert.equal(managedFiles(x.backupDir).length, 2);
    assert.equal(fs.readFileSync(path.join(x.backupDir, "other.sqlite"), "utf8"), "not managed");
    assert.equal(fs.readFileSync(path.join(x.backupDir, "notes.txt"), "utf8"), "keep");
    for (const filename of managedFiles(x.backupDir)) assert.equal(verifyBackupFile(path.join(x.backupDir, filename)), true);
  } finally { x.close(); }
});

test("даже при минимальном сроке хранения остаётся последняя исправная копия", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    const manager = x.manager({ retentionCount: 1 });
    const first = await manager.createBackup();
    const second = await manager.createBackup();
    assert.equal(fs.existsSync(second.path), true);
    assert.equal(verifyBackupFile(second.path), true);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(managedFiles(x.backupDir).length, 1);
  } finally { x.close(); }
});

test("повреждённая копия не считается исправной и не удаляется как чужой файл", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    fs.mkdirSync(x.backupDir, { recursive: true });
    const damaged = path.join(x.backupDir, `magic-morning-20200101T000000.000Z-${"a".repeat(8)}-${"b".repeat(4)}-4ccc-8ddd-${"e".repeat(12)}.sqlite`);
    fs.writeFileSync(damaged, "not a SQLite database");
    const result = await x.manager({ retentionCount: 1 }).createBackup();
    assert.equal(result.retention.healthyCount, 1);
    assert.equal(verifyBackupFile(result.path), true);
    assert.equal(fs.existsSync(damaged), true);
  } finally { x.close(); }
});

test("восстановление из копии возвращает участников, аккаунты и незавершённые регистрации", async () => {
  const x = setupDatabase();
  let restoreDb;
  try {
    const participant = x.addFakeData();
    const result = await x.manager().createBackup();
    const restorePath = path.join(x.directory, "restored.sqlite");
    x.db.closeDatabase();
    fs.copyFileSync(result.path, restorePath);
    restoreDb = new BetterSqlite3(restorePath, { fileMustExist: true });
    assert.deepEqual(restoreDb.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
    assert.equal(restoreDb.prepare("SELECT first_name FROM participants WHERE id=?").get(participant.id).first_name, "ТестовоеИмя");
    assert.equal(restoreDb.prepare("SELECT messenger_user_id FROM accounts WHERE participant_id=?").get(participant.id).messenger_user_id, "700000001");
    assert.equal(restoreDb.prepare("SELECT current_step FROM registration_drafts WHERE messenger_user_id='700000004'").get().current_step, "email");
  } finally {
    try { restoreDb?.close(); } catch {}
    x.close();
  }
});

test("интеграционный сценарий: копия старой схемы, миграция, восстановление и чтение связанных данных", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrate-backup-"));
  const sourcePath = path.join(directory, "old-source.sqlite");
  const backupDir = path.join(directory, "backups");
  const sourceDb = new BetterSqlite3(sourcePath);
  let restored;
  try {
    sourceDb.pragma("foreign_keys = ON");
    createBaseSchema(sourceDb);
    sourceDb.pragma("user_version = 1");
    const person = sourceDb.prepare("INSERT INTO participants(first_name,last_name,phone,personal_data_consent) VALUES(?,?,?,?)").run("СинтетическоеИмя", "ПробнаяФамилия", "+99970000009", 1);
    sourceDb.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,?,?)").run(person.lastInsertRowid, "telegram", "700000009");
    sourceDb.prepare("INSERT INTO admins(telegram_id,role) VALUES(?,?)").run("700000010", "owner");
    sourceDb.prepare("INSERT INTO registration_drafts(platform,messenger_user_id,current_step,answers_json) VALUES(?,?,?,?)").run("telegram", "700000011", "city", JSON.stringify({ first_name: "ЧерновоеИмя" }));

    const manager = createBackupManager({ sourceDb, sourcePath, backupDir, sourceType: "production" });
    const backup = await manager.createBackup();
    assert.equal(backup.metadata.schema_version, 1);
    assert.equal(verifyBackupFile(backup.path, { requireMetadata: true }), true);

    migrateDatabase(sourceDb);
    assert.equal(sourceDb.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(sourceDb.prepare("SELECT first_name FROM participants WHERE id=?").get(person.lastInsertRowid).first_name, "СинтетическоеИмя");
    assert.equal(sourceDb.prepare("SELECT COUNT(*) AS n FROM registration_drafts").get().n, 1);

    const restoredPath = path.join(directory, "recovered", "recovered.sqlite");
    const restoredResult = restoreBackup(backup.path, restoredPath);
    assert.equal(restoredResult.verified, true);
    assert.equal(verifyBackupFile(restoredPath, { requireMetadata: true }), true);
    restored = new BetterSqlite3(restoredPath);
    assert.equal(restored.pragma("user_version", { simple: true }), 1);
    const readParticipant = restored.prepare("SELECT first_name,phone FROM participants WHERE id=?").get(person.lastInsertRowid);
    assert.deepEqual(readParticipant, { first_name: "СинтетическоеИмя", phone: "+99970000009" });
    assert.equal(restored.prepare("SELECT messenger_user_id FROM accounts WHERE participant_id=?").get(person.lastInsertRowid).messenger_user_id, "700000009");
    assert.equal(restored.prepare("SELECT role FROM admins WHERE telegram_id='700000010'").get().role, "owner");
    assert.equal(restored.prepare("SELECT current_step FROM registration_drafts WHERE messenger_user_id='700000011'").get().current_step, "city");
    assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
    migrateDatabase(restored);
    assert.equal(restored.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(restored.prepare("SELECT first_name FROM participants WHERE phone=?").get("+99970000009").first_name, "СинтетическоеИмя");
  } finally {
    try { restored?.close(); } catch {}
    try { sourceDb.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("источник демонстрации нельзя обозначить рабочей базой", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-demo-backup-guard-"));
  const demoDir = path.join(directory, "data");
  fs.mkdirSync(demoDir);
  const demoPath = path.join(demoDir, "demo.sqlite");
  const demoDb = new BetterSqlite3(demoPath);
  try {
    createBaseSchema(demoDb);
    migrateDatabase(demoDb);
    const manager = createBackupManager({ sourceDb: demoDb, sourcePath: demoPath, backupDir: path.join(directory, "backups"), sourceType: "production", projectRoot: directory });
    await assert.rejects(manager.createBackup(), /demo.sqlite нельзя|демонстрационная база не может/);
    assert.equal(fs.existsSync(path.join(directory, "backups")), false);
    assert.throws(() => classifyDatabasePath(demoPath, { projectRoot: directory }), /demo.sqlite нельзя/);
    assert.equal(classifyDatabasePath(demoPath, { demoMode: "true", projectRoot: directory }), "demo");
  } finally { demoDb.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("backup прекращается, если фактически открытый файл не совпадает с ожидаемым путём", async () => {
  const x = setupDatabase();
  const other = path.join(x.directory, "other.sqlite");
  const otherDb = new BetterSqlite3(other);
  try {
    otherDb.exec("CREATE TABLE marker(value TEXT)");
    const manager = createBackupManager({ sourceDb: x.db.db, sourcePath: other, backupDir: x.backupDir });
    await assert.rejects(manager.createBackup(), /не совпадает с ожидаемым источником/);
    assert.equal(fs.existsSync(x.backupDir), false);
  } finally { otherDb.close(); x.close(); }
});

test("изменение файла после резервирования обнаруживается по размеру или checksum", async () => {
  const x = setupDatabase();
  try {
    x.addFakeData();
    const result = await x.manager().createBackup();
    fs.appendFileSync(result.path, Buffer.from([0]));
    assert.throws(() => verifyBackupFile(result.path, { requireMetadata: true }), /Контрольная сумма|размер/);
  } finally { x.close(); }
});

test("параметры автоматического расписания поддерживают отключение и заданный интервал", async () => {
  let calls = 0;
  let callback;
  let delay;
  let cleared = false;
  const manager = { createBackup: async () => { calls += 1; } };
  const logger = { info() {}, error() {} };
  startAutomaticBackups(manager, {
    enabled: false,
    intervalMs: 1234,
    logger,
    setIntervalFn: () => { throw new Error("timer should be disabled"); }
  });
  assert.equal(calls, 0);
  const stop = startAutomaticBackups(manager, {
    enabled: true,
    intervalMs: 4321,
    logger,
    setIntervalFn: (fn, ms) => { callback = fn; delay = ms; return { unref() {} }; },
    clearIntervalFn: () => { cleared = true; }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delay, 4321);
  assert.equal(calls, 1);
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  stop();
  assert.equal(cleared, true);
});

test("автоматический планировщик безопасно журналирует ошибку без исходного текста", async () => {
  const logs = [];
  const manager = { createBackup: async () => { throw new Error("sensitive@example.invalid phone +79990000001"); } };
  startAutomaticBackups(manager, {
    enabled: true,
    intervalMs: 60_000,
    logger: { error: (line) => logs.push(line) },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {}
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /sqlite_backup_failed/);
  assert.doesNotMatch(logs[0], /sensitive|example\.invalid|\+79990000001/);
});

test("настройки резервирования читают интервал, число копий, папку и отключение автоматики", () => {
  const settings = readBackupSettings({
    BACKUP_DIR: "./private-backups",
    BACKUP_INTERVAL_HOURS: "12",
    BACKUP_RETENTION_COUNT: "7",
    BACKUP_AUTO_ENABLED: "false"
  });
  assert.equal(settings.backupDir, path.resolve("./private-backups"));
  assert.equal(settings.intervalHours, 12);
  assert.equal(settings.retentionCount, 7);
  assert.equal(settings.autoEnabled, false);
  assert.equal(readBackupSettings({}).intervalHours, 24);
  assert.equal(readBackupSettings({}).retentionCount, 14);
});

test("тестовые записи вымышленные, а база находится во временной папке", () => {
  const x = setupDatabase();
  try {
    const participant = x.addFakeData();
    assert.ok(path.relative(os.tmpdir(), x.dbPath) && !path.isAbsolute(path.relative(os.tmpdir(), x.dbPath)));
    assert.equal(participant.email, "synthetic@example.invalid");
    assert.equal(participant.phone, "+79990000001");
    assert.doesNotMatch(x.dbPath, /data[\\/]club\.sqlite$/i);
  } finally { x.close(); }
});

test("остановка планировщика ждёт завершения уже начатой копии базы", async () => {
  let resolveBackup;
  let calls = 0;
  let intervalCallback;
  let intervalCleared = false;
  const manager = { createBackup() {
    calls += 1;
    return new Promise((resolve) => { resolveBackup = resolve; });
  } };
  const stop = startAutomaticBackups(manager, {
    intervalMs: 10,
    logger: { info() {}, error() {} },
    setIntervalFn(callback) { intervalCallback = callback; return { unref() {} }; },
    clearIntervalFn() { intervalCleared = true; }
  });
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(intervalCleared, true);
  assert.equal(stopped, false);
  intervalCallback();
  assert.equal(calls, 1);
  resolveBackup();
  await stopping;
  assert.equal(stopped, true);
});

