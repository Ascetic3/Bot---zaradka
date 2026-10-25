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
    const metadataCount = metadataPresent ? probe.prepare("SELECT COUNT(*) AS count FROM demo_seed_metadata").get().count : 0;
    if (!metadataPresent && Object.values(counts).some((count) => count !== 0)) {
      throw new Error("В demo.sqlite уже есть неразмеченные данные. Автоматическое заполнение остановлено, существующие записи сохранены.");
    }
    let metadata = null;
    if (metadataPresent) metadata = probe.prepare("SELECT seed_name, seed_version, seeded_at, participant_count FROM demo_seed_metadata WHERE seed_name=?").get(seedName) || null;
    if (metadataPresent && !metadata) throw new Error("В demo.sqlite есть неизвестная метка набора. Файл оставлен без изменений.");
    return { metadata, metadataCount, counts, tables };
  } finally { probe.close(); }
}

function expectedAccountKeys(records) {
  return records.flatMap((person) => person.accounts.map((account) => `${person.phone}\u0000${account.platform}\u0000${account.messenger_user_id}`)).sort();
}

function assertSeedMatches(database, records, metadata) {
  const connection = database.db ?? database;
  if (metadata.seed_version !== seedVersion || metadata.participant_count !== records.length) {
    throw new Error("Версия демонстрационного набора не совпадает. Существующие данные не изменены.");
  }
  const hasConsentVersion = connection.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_version");
  const consentVersionSelect = hasConsentVersion ? "p.consent_version" : "NULL AS consent_version";
  const testConsentVersionSelect = hasConsentVersion ? "p.consent_version" : "NULL AS consent_version";
  const hasTestMarkers = connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='demo_test_participants'").get();
  if (!hasTestMarkers) throw new Error("Схема демобазы не поддерживает безопасную маркировку тестовых анкет.");
  const actual = connection.prepare(`SELECT p.id, p.first_name, p.last_name, p.phone, p.city, p.email, p.preferred_contact, p.referral_source,
      p.registered_at, p.updated_at, p.phone_confirmed_at, p.personal_data_consent, p.consent_at, ${consentVersionSelect}
      FROM participants p LEFT JOIN demo_test_participants t ON t.participant_id=p.id WHERE t.participant_id IS NULL ORDER BY p.id`).all();
  const hasWithdrawalTimestamp = connection.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_withdrawn_at");
  const withdrawnSelect = hasWithdrawalTimestamp ? "p.consent_withdrawn_at" : "NULL AS consent_withdrawn_at";
  const testParticipants = connection.prepare(`SELECT p.id,p.phone,${testConsentVersionSelect},p.personal_data_consent,p.phone_confirmed_at,p.consent_at,${withdrawnSelect},
      COUNT(a.id) AS account_count,SUM(CASE WHEN a.platform='telegram' THEN 1 ELSE 0 END) AS telegram_count
      FROM demo_test_participants t JOIN participants p ON p.id=t.participant_id LEFT JOIN accounts a ON a.participant_id=p.id
      GROUP BY p.id ORDER BY p.id`).all();
  if (connection.prepare("SELECT COUNT(*) AS count FROM participants").get().count !== records.length + testParticipants.length) throw new Error("Демонстрационная база изменена: обнаружены неразмеченные дополнительные участники.");
  if (testParticipants.some((row) => !/^\+7000000\d{4}$/.test(row.phone) || row.consent_version !== "DEMO_TEST_ONLY_V1" || !row.consent_at || (row.personal_data_consent !== 1 && !(row.personal_data_consent === 0 && row.consent_withdrawn_at)) || !row.phone_confirmed_at || row.telegram_count !== 1 || row.account_count !== 1)) {
    throw new Error("Найдена некорректная или неподтверждённая метка тестовой анкеты.");
  }
  if (actual.length !== records.length) throw new Error("Исходные записи генератора изменены. Повторное заполнение остановлено без изменений.");
  const expectedByPhone = new Map(records.map((person) => [person.phone, person]));
  for (const [index, row] of actual.entries()) {
    const expected = expectedByPhone.get(row.phone);
    if (!expected) throw new Error("В демонстрационной базе есть неизвестные участники. Повторное заполнение остановлено без изменений.");
    if (row.id !== index + 1) throw new Error("Порядок демонстрационных записей изменился. Проверка остановлена без изменений.");
    for (const key of ["first_name", "last_name", "phone", "city", "email", "preferred_contact", "referral_source", "registered_at", "updated_at", "phone_confirmed_at", "personal_data_consent", "consent_at", "consent_version"]) {
      if ((row[key] ?? null) !== (expected[key] ?? null)) throw new Error("Содержимое демонстрационной базы изменилось. Повторное заполнение остановлено без изменений.");
    }
  }
  const accountRows = connection.prepare(`SELECT p.phone, a.participant_id, a.platform, a.messenger_user_id FROM accounts a
      JOIN participants p ON p.id=a.participant_id LEFT JOIN demo_test_participants t ON t.participant_id=p.id
      WHERE t.participant_id IS NULL ORDER BY p.phone, a.platform, a.messenger_user_id`).all();
  const actualKeys = accountRows.map((row) => `${row.phone ?? `ORPHAN-${row.participant_id}`}\u0000${row.platform}\u0000${row.messenger_user_id}`).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedAccountKeys(records))) throw new Error("Связанные демонстрационные аккаунты изменились. Проверка остановлена без изменений.");
  if (connection.prepare("SELECT COUNT(*) AS count FROM registration_drafts").get().count !== 0) throw new Error("В демонстрационной базе обнаружены незавершённые анкеты. Проверка остановлена без изменений.");
}

function assertDemoOwner(database, ownerTelegramId) {
  const connection = database.db ?? database;
  const admins = connection.prepare("SELECT telegram_id, role FROM admins ORDER BY telegram_id").all();
  const owners = admins.filter((admin) => admin.role === "owner");
  if (owners.length !== 1 || owners[0].telegram_id !== String(ownerTelegramId)) {
    throw new Error("В демонстрационной базе должен оставаться единственный настроенный владелец. Проверка остановлена без изменений.");
  }
  // Администраторов владелец может добавлять и удалять через бота. Это
  // изменяемые рабочие записи, поэтому их число не является частью seed-проверки.
  // Проверяем лишь допустимый формат ролей/ID; новые права здесь не назначаются.
  if (admins.some((admin) => !/^\d+$/.test(String(admin.telegram_id)) || !["owner", "admin"].includes(admin.role))) {
    throw new Error("В таблице администраторов найдена некорректная запись. Проверьте её вручную; база не изменена.");
  }
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
        const inspection = readOnlyInspection(resolvedTarget);
        if (inspection.metadataCount !== 1) throw new Error("В демонстрационной базе обнаружены лишние метки набора. Повторное заполнение остановлено без изменений.");
        assertDemoOwner(database, ownerTelegramId);
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

function verifyDemoDatabase({ databasePath = defaultDemoPath, productionDatabasePath = defaultProductionPath, ownerTelegramId, DatabaseConstructor = Database } = {}) {
  if (canonicalPath(databasePath) === canonicalPath(productionDatabasePath)) throw new Error("Отказ: для демонстрационного запуска указан путь рабочей базы.");
  if (!/^\d+$/.test(String(ownerTelegramId || ""))) throw new Error("OWNER_TELEGRAM_ID не настроен корректно для демонстрационной базы.");
  if (!fs.existsSync(databasePath)) throw new Error("Демонстрационная база отсутствует. Сначала выполните npm.cmd run demo:seed.");
  const inspection = readOnlyInspection(databasePath);
  if (!inspection.metadata || inspection.metadataCount !== 1 || inspection.metadata.seed_name !== seedName || inspection.metadata.seed_version !== seedVersion || inspection.metadata.participant_count !== 150) {
    throw new Error("Демонстрационная база не содержит проверенный набор из 150 участников.");
  }
  const expectedRecords = createDemoRecords(inspection.metadata.seeded_at);
  const probe = new DatabaseConstructor(databasePath, { readonly: true, fileMustExist: true });
  try {
    assertSeedMatches(probe, expectedRecords, inspection.metadata);
    if (inspection.counts.registration_drafts !== 0) throw new Error("В демонстрационной базе обнаружены незавершённые анкеты. Запуск остановлен без изменений.");
    assertDemoOwner(probe, ownerTelegramId);
    return { count: inspection.counts.participants, ownerConfigured: true };
  } finally { probe.close(); }
}

module.exports = { seedDemoDatabase, verifyDemoDatabase, defaultDemoPath, defaultProductionPath, ensureSafeTarget };

