const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDemoRecords } = require("./data");
const { getDatabasePath } = require("../database/config");

const requiredTables = ["participants", "accounts", "admins", "registration_drafts"];
const seedName = "magic-morning-demo";
const seedVersion = 1;
const projectRoot = path.resolve(__dirname, "../..");
const defaultDemoPath = path.join(projectRoot, "data", "demo.sqlite");
const defaultProductionPath = path.join(projectRoot, "data", "club.sqlite");

function canonicalPath(filePath) {
  const absolute = path.resolve(filePath);
  try { return fs.realpathSync(absolute).toLocaleLowerCase("en-US"); }
  catch {
    let existingParent = path.dirname(absolute);
    let remainder = path.basename(absolute);
    while (!fs.existsSync(existingParent)) {
      const parentName = path.basename(existingParent);
      const nextParent = path.dirname(existingParent);
      if (nextParent === existingParent) throw new Error("Не удалось безопасно определить путь базы.");
      remainder = path.join(parentName, remainder);
      existingParent = nextParent;
    }
    const realParent = fs.realpathSync(existingParent);
    return path.join(realParent, remainder).toLocaleLowerCase("en-US");
  }
}

function ensureSafeTarget(databasePath, configuredDatabasePath, productionDatabasePath) {
  const target = canonicalPath(databasePath);
  if (target === canonicalPath(productionDatabasePath) || target === canonicalPath(configuredDatabasePath)) {
    throw new Error("Отказ: путь демонстрационной базы совпадает с рабочей базой.");
  }
}

function readOnlyInspection(filePath) {
  const probe = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = probe.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error("Файл demo.sqlite не прошёл проверку целостности.");
    const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!requiredTables.every((table) => tables.has(table))) throw new Error("Существующая demo.sqlite не содержит ожидаемую схему. Файл оставлен без изменений.");
    const metadataPresent = tables.has("demo_seed_metadata");
    const counts = Object.fromEntries([...requiredTables].map((table) => [table, probe.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    if (!metadataPresent && Object.values(counts).some((count) => count !== 0)) {
      throw new Error("В demo.sqlite уже есть неразмеченные данные. Автоматическое заполнение остановлено, существующие записи сохранены.");
    }
    let metadata = null;
    if (metadataPresent) metadata = probe.prepare("SELECT seed_name, seed_version, seeded_at, participant_count FROM demo_seed_metadata WHERE seed_name=?").get(seedName) || null;
    if (metadataPresent && !metadata) throw new Error("В demo.sqlite есть неизвестная метка набора. Файл оставлен без изменений.");
    return { metadata, counts, tables };
  } finally { probe.close(); }
}

function expectedAccountKeys(records) {
  return records.flatMap((person) => person.accounts.map((account) => `${person.phone}\u0000${account.platform}\u0000${account.messenger_user_id}`)).sort();
}

function assertSeedMatches(database, records, metadata) {
  if (metadata.seed_version !== seedVersion || metadata.participant_count !== records.length) {
    throw new Error("Версия демонстрационного набора не совпадает. Существующие данные не изменены.");
  }
  const actual = database.db.prepare(`SELECT id, first_name, last_name, phone, city, email, preferred_contact, referral_source,
      registered_at, updated_at, phone_confirmed_at, personal_data_consent, consent_at FROM participants ORDER BY id`).all();
  if (actual.length !== records.length) throw new Error("Демонстрационная база изменена после заполнения. Повторное заполнение остановлено без изменений.");
  const expectedByPhone = new Map(records.map((person) => [person.phone, person]));
  for (const row of actual) {
    const expected = expectedByPhone.get(row.phone);
    if (!expected) throw new Error("В демонстрационной базе есть неизвестные участники. Повторное заполнение остановлено без изменений.");
    for (const key of ["first_name", "last_name", "phone", "city", "email", "preferred_contact", "referral_source", "registered_at", "updated_at", "phone_confirmed_at", "personal_data_consent", "consent_at"]) {
      if ((row[key] ?? null) !== (expected[key] ?? null)) throw new Error("Содержимое демонстрационной базы изменилось. Повторное заполнение остановлено без изменений.");
    }
  }
  const accountRows = database.db.prepare(`SELECT p.phone, a.platform, a.messenger_user_id FROM accounts a
      JOIN participants p ON p.id=a.participant_id ORDER BY p.phone, a.platform, a.messenger_user_id`).all();
  const actualKeys = accountRows.map((row) => `${row.phone}\u0000${row.platform}\u0000${row.messenger_user_id}`).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedAccountKeys(records))) throw new Error("Связанные демонстрационные аккаунты изменились. Повторное заполнение остановлено без изменений.");
}

function seedDemoDatabase({
  databasePath = defaultDemoPath,
  configuredDatabasePath = process.env.DB_PATH ? getDatabasePath(process.env) : defaultProductionPath,
  productionDatabasePath = defaultProductionPath,
  ownerTelegramId,
  now = new Date(),
  DatabaseConstructor = Database
} = {}) {
  ensureSafeTarget(databasePath, configuredDatabasePath, productionDatabasePath);
  if (!/^\d+$/.test(String(ownerTelegramId || ""))) throw new Error("В .env должна быть настроена действительная OWNER_TELEGRAM_ID владельца.");
  const resolvedTarget = path.resolve(databasePath);
  if (fs.existsSync(resolvedTarget)) readOnlyInspection(resolvedTarget);

  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  const databaseModulePath = require.resolve("../database");
  if (require.cache[databaseModulePath]) throw new Error("Закройте текущее подключение к базе перед наполнением демонстрационной базы.");
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = resolvedTarget;
  let database;
  try {
    delete require.cache[databaseModulePath];
    database = require("../database");
    const existingInspection = fs.existsSync(resolvedTarget) ? readOnlyInspection(resolvedTarget) : { metadata: null };
    if (existingInspection.metadata) {
      if (database.getAdminRole(ownerTelegramId) !== "owner") throw new Error("В демонстрационной базе назначен другой владелец. Автоматическая замена запрещена.");
    } else {
      database.initializeOwner(ownerTelegramId);
      if (database.getAdminRole(ownerTelegramId) !== "owner") throw new Error("Не удалось безопасно назначить владельца демонстрационной базы.");
    }

    const result = database.db.transaction(() => {
      database.db.exec(`CREATE TABLE IF NOT EXISTS demo_seed_metadata (
        seed_name TEXT PRIMARY KEY,
        seed_version INTEGER NOT NULL,
        seeded_at TEXT NOT NULL,
        participant_count INTEGER NOT NULL
      )`);
      const metadata = database.db.prepare("SELECT seed_name, seed_version, seeded_at, participant_count FROM demo_seed_metadata WHERE seed_name=?").get(seedName);
      if (metadata) {
        const records = createDemoRecords(metadata.seeded_at);
        assertSeedMatches(database, records, metadata);
        return { inserted: 0, alreadySeeded: true, count: records.length };
      }

      const existingCounts = Object.fromEntries(["participants", "accounts", "registration_drafts"].map((table) => [table, database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
      if (Object.values(existingCounts).some((count) => count !== 0)) throw new Error("В demo.sqlite уже есть данные без метки генератора. Они не были изменены.");
      const adminRows = database.listAdmins();
      if (adminRows.length !== 1 || adminRows[0].telegram_id !== String(ownerTelegramId) || adminRows[0].role !== "owner") {
        throw new Error("Состав администраторов демонстрационной базы отличается от ожидаемого. Автоматическое заполнение остановлено.");
      }

      const anchor = new Date(now).toISOString();
      const records = createDemoRecords(anchor);
      database.db.prepare("INSERT INTO demo_seed_metadata(seed_name,seed_version,seeded_at,participant_count) VALUES(?,?,?,?)").run(seedName, seedVersion, anchor, records.length);
      const insertParticipant = database.db.prepare(`INSERT INTO participants(
        first_name,last_name,phone,city,email,preferred_contact,referral_source,registered_at,updated_at,
        phone_confirmed_at,personal_data_consent,consent_at
      ) VALUES(@first_name,@last_name,@phone,@city,@email,@preferred_contact,@referral_source,@registered_at,@updated_at,
        @phone_confirmed_at,@personal_data_consent,@consent_at)`);
      const insertAccount = database.db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,?,?)");
      for (const person of records) {
        const result = insertParticipant.run(person);
        for (const account of person.accounts) insertAccount.run(result.lastInsertRowid, account.platform, account.messenger_user_id);
      }
      return { inserted: records.length, alreadySeeded: false, count: records.length };
    })();
    return { ...result, databasePath: resolvedTarget };
  } finally {
    if (database?.db?.open) database.closeDatabase();
    delete require.cache[databaseModulePath];
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
  }
}

function verifyDemoDatabase({ databasePath = defaultDemoPath, ownerTelegramId, DatabaseConstructor = Database } = {}) {
  if (!fs.existsSync(databasePath)) throw new Error("Демонстрационная база отсутствует. Сначала выполните npm.cmd run demo:seed.");
  const inspection = readOnlyInspection(databasePath);
  if (!inspection.metadata || inspection.metadata.participant_count !== 150 || inspection.counts.participants !== 150) {
    throw new Error("Демонстрационная база не содержит проверенный набор из 150 участников.");
  }
  const probe = new DatabaseConstructor(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (probe.prepare("SELECT role FROM admins WHERE telegram_id=?").get(String(ownerTelegramId))?.role !== "owner") {
      throw new Error("OWNER_TELEGRAM_ID не является владельцем демонстрационной базы.");
    }
    return { count: inspection.counts.participants, ownerConfigured: true };
  } finally { probe.close(); }
}

module.exports = { seedDemoDatabase, verifyDemoDatabase, defaultDemoPath, defaultProductionPath, ensureSafeTarget };
