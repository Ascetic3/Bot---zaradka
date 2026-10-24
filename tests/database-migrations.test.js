const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { CURRENT_SCHEMA_VERSION, createBaseSchema, inspectSchema, migrateDatabase, previewMigrations } = require("../src/database/migrations");
const { runMigrationCommand } = require("../src/database/migrate-cli");

function fixture({ version = 1, legacyConsent = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrations-"));
  const file = path.join(directory, "fixture.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  createBaseSchema(db);
  if (legacyConsent) {
    db.exec("ALTER TABLE participants ADD COLUMN consent_at TEXT; ALTER TABLE participants ADD COLUMN consent_version TEXT; ALTER TABLE admins ADD COLUMN username TEXT;");
  }
  db.pragma(`user_version = ${version}`);
  return { directory, file, db, close() { try { db.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); } };
}

function legacyFixture({ consentAt = false, consentVersion = false, username = false, demoMetadata = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrations-legacy-copy-"));
  const file = path.join(directory, "legacy.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  createBaseSchema(db);
  if (consentAt) db.exec("ALTER TABLE participants ADD COLUMN consent_at TEXT");
  if (consentVersion) db.exec("ALTER TABLE participants ADD COLUMN consent_version TEXT");
  if (username) db.exec("ALTER TABLE admins ADD COLUMN username TEXT");
  if (demoMetadata) {
    db.exec(`CREATE TABLE demo_seed_metadata (
      seed_name TEXT PRIMARY KEY,
      seed_version INTEGER NOT NULL,
      seeded_at TEXT NOT NULL,
      participant_count INTEGER NOT NULL
    )`);
    db.prepare("INSERT INTO demo_seed_metadata VALUES(?,?,?,?)").run("synthetic-seed", 1, "2026-01-01T00:00:00.000Z", 150);
  }
  return { directory, file, db, close() { try { db.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); } };
}

function fill(db, { legacyConsent = false } = {}) {
  const insert = legacyConsent
    ? db.prepare("INSERT INTO participants(first_name,last_name,phone,phone_confirmed_at,personal_data_consent,consent_at,consent_version) VALUES(?,?,?,?,?,?,?)")
    : db.prepare("INSERT INTO participants(first_name,last_name,phone,phone_confirmed_at,personal_data_consent) VALUES(?,?,?,?,?)");
  const p = legacyConsent
    ? insert.run("ВымышленноеИмя", "ТестоваяФамилия", "+99970000001", "2026-01-01T00:00:00.000Z", 1, "2026-01-01T00:00:01.000Z", "policy-test-v1")
    : insert.run("ВымышленноеИмя", "ТестоваяФамилия", "+99970000001", "2026-01-01T00:00:00.000Z", 1);
  db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,?,?)").run(p.lastInsertRowid, "telegram", "700000001");
  db.prepare("INSERT INTO admins(telegram_id,role) VALUES(?,?)").run("700000002", "owner");
  if (legacyConsent) db.prepare("UPDATE admins SET username=? WHERE telegram_id=?").run("demo_owner", "700000002");
  db.prepare("INSERT INTO registration_drafts(platform,messenger_user_id,current_step,answers_json) VALUES(?,?,?,?)").run("telegram", "700000003", "email", JSON.stringify({ first_name: "ЧерновоеИмя" }));
  return Number(p.lastInsertRowid);
}

test("новая пустая база проходит последовательные версии до актуальной схемы", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrations-empty-"));
  const db = new Database(path.join(directory, "new.sqlite"));
  try {
    const result = migrateDatabase(db);
    assert.equal(result.to, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(result.applied.map((step) => step.version), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(inspectSchema(db, { allowKnownOptionalColumns: false }).version, CURRENT_SCHEMA_VERSION);
    assert.equal(db.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_at"), true);
    assert.equal(db.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_version"), true);
    assert.equal(db.prepare("PRAGMA table_info(admins)").all().some((column) => column.name === "username"), true);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("старая схема обновляется без потери участников, аккаунтов, владельцев и черновиков", () => {
  const x = fixture({ version: 1 });
  try {
    const participantId = fill(x.db);
    const preview = previewMigrations(x.db);
    assert.equal(preview.currentVersion, 1);
    assert.deepEqual(preview.plan.map((step) => step.version), [2, 3, 4, 5, 6, 7]);
    const result = migrateDatabase(x.db);
    assert.equal(result.to, CURRENT_SCHEMA_VERSION);
    assert.equal(x.db.prepare("SELECT first_name FROM participants WHERE id=?").get(participantId).first_name, "ВымышленноеИмя");
    assert.equal(x.db.prepare("SELECT messenger_user_id FROM accounts WHERE participant_id=?").get(participantId).messenger_user_id, "700000001");
    assert.equal(x.db.prepare("SELECT role FROM admins WHERE telegram_id='700000002'").get().role, "owner");
    assert.equal(x.db.prepare("SELECT current_step FROM registration_drafts WHERE messenger_user_id='700000003'").get().current_step, "email");
    assert.equal(x.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { x.close(); }
});

test("миграция сохраняет consent_at, consent_version и admins.username уже существующей legacy-базы", () => {
  const x = fixture({ version: 0, legacyConsent: true });
  try {
    const participantId = fill(x.db, { legacyConsent: true });
    migrateDatabase(x.db);
    const participant = x.db.prepare("SELECT personal_data_consent,consent_at,consent_version FROM participants WHERE id=?").get(participantId);
    assert.deepEqual(participant, { personal_data_consent: 1, consent_at: "2026-01-01T00:00:01.000Z", consent_version: "policy-test-v1" });
    assert.equal(x.db.prepare("SELECT username FROM admins WHERE telegram_id='700000002'").get().username, "demo_owner");
  } finally { x.close(); }
});

test("копия фактической клубной схемы с consent_at распознаётся как версия 2 и добавляет только недостающие столбцы", () => {
  const x = legacyFixture({ consentAt: true });
  try {
    const participantId = fill(x.db);
    const preview = previewMigrations(x.db);
    assert.equal(preview.currentVersion, 0);
    assert.equal(preview.structuralVersion, 2);
    assert.deepEqual(preview.plan.map((step) => step.version), [3, 4, 5, 6, 7]);
    const result = migrateDatabase(x.db);
    assert.deepEqual(result.applied.map((step) => step.version), [3, 4, 5, 6, 7]);
    const columns = x.db.prepare("PRAGMA table_info(participants)").all().map((column) => column.name);
    assert.equal(columns.filter((name) => name === "consent_at").length, 1);
    assert.equal(columns.includes("consent_version"), true);
    assert.equal(x.db.prepare("SELECT first_name FROM participants WHERE id=?").get(participantId).first_name, "ВымышленноеИмя");
  } finally { x.close(); }
});

test("полная схема версии 4 с user_version=0 применяет только миграцию учёта отзыва согласия", () => {
  const x = legacyFixture({ consentAt: true, consentVersion: true, username: true });
  try {
    const participantId = fill(x.db, { legacyConsent: true });
    const beforeDdl = x.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name").all();
    const preview = previewMigrations(x.db);
    assert.equal(preview.structuralVersion, 4);
    assert.deepEqual(preview.plan.map((step) => step.version), [5, 6, 7]);
    const result = migrateDatabase(x.db);
    assert.equal(result.stampedVersion, true);
    assert.deepEqual(result.applied.map((step) => step.version), [5, 6, 7]);
    assert.notDeepEqual(x.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name").all(), beforeDdl);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS count FROM consent_withdrawal_requests").get().count, 0);
    assert.equal(x.db.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(x.db.prepare("SELECT consent_version FROM participants WHERE id=?").get(participantId).consent_version, "policy-test-v1");
    assert.equal(migrateDatabase(x.db).applied.length, 0);
  } finally { x.close(); }
});

test("схема-представитель demo.sqlite мигрируется без потери синтетических участников и метаданных", () => {
  const x = legacyFixture({ consentAt: true, demoMetadata: true });
  try {
    const participantId = fill(x.db);
    const beforeMetadata = x.db.prepare("SELECT * FROM demo_seed_metadata").get();
    assert.equal(previewMigrations(x.db).structuralVersion, 2);
    migrateDatabase(x.db);
    assert.deepEqual(x.db.prepare("SELECT * FROM demo_seed_metadata").get(), beforeMetadata);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants WHERE id=?").get(participantId).n, 1);
    assert.equal(x.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { x.close(); }
});

test("версия 0 с нарушенной последовательностью необязательных столбцов отклоняется без изменений", () => {
  const x = legacyFixture({ consentVersion: true });
  try {
    const beforeColumns = x.db.prepare("PRAGMA table_info(participants)").all().map((column) => column.name);
    assert.throws(() => previewMigrations(x.db), /противоречива/);
    assert.throws(() => migrateDatabase(x.db), /противоречива/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(x.db.prepare("PRAGMA table_info(participants)").all().map((column) => column.name), beforeColumns);
  } finally { x.close(); }
});

test("повторный запуск миграции актуальной схемы ничего не меняет", () => {
  const x = fixture({ version: 1 });
  try {
    fill(x.db);
    migrateDatabase(x.db);
    const before = x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n;
    assert.deepEqual(migrateDatabase(x.db).applied, []);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, before);
  } finally { x.close(); }
});

test("ошибка внутри шага откатывает изменения столбца и user_version этого шага", () => {
  const x = fixture({ version: 1 });
  try {
    fill(x.db);
    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 2) throw new Error("synthetic failure"); } }), /synthetic failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 1);
    assert.equal(x.db.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_at"), false);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 1);
  } finally { x.close(); }
});

test("ошибка миграции отзыва согласия откатывает таблицу и столбец версии 5", () => {
  const x = fixture({ version: 4, legacyConsent: true });
  try {
    const participantId = fill(x.db, { legacyConsent: true });
    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 5) throw new Error("synthetic v5 failure"); } }), /synthetic v5 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 4);
    assert.equal(x.db.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_withdrawn_at"), false);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='consent_withdrawal_requests'").get().count, 0);
    assert.equal(x.db.prepare("SELECT consent_version FROM participants WHERE id=?").get(participantId).consent_version, "policy-test-v1");
  } finally { x.close(); }
});

test("ошибка миграции запросов связывания откатывает таблицу, триггер и user_version", () => {
  const x = fixture({ version: 4, legacyConsent: true });
  try {
    x.db.exec(`ALTER TABLE participants ADD COLUMN consent_withdrawn_at TEXT;
      CREATE TABLE consent_withdrawal_requests (
        id INTEGER PRIMARY KEY,
        participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        consent_at TEXT NOT NULL,
        requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','processed','not_applicable')),
        resolved_at TEXT,
        UNIQUE(participant_id, consent_at)
      );`);
    x.db.pragma("user_version = 5");
    const participantId = fill(x.db, { legacyConsent: true });
    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 6) throw new Error("synthetic v6 failure"); } }), /synthetic v6 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 5);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='account_link_requests'").get().n, 0);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='trg_account_link_requests_state_transition'").get().n, 0);
    assert.equal(x.db.prepare("SELECT first_name FROM participants WHERE id=?").get(participantId).first_name, "ВымышленноеИмя");
  } finally { x.close(); }
});

test("миграция v7 добавляет запросы удаления без потери связанных данных и повторно безопасна", () => {
  const x = fixture({ version: 1 });
  try {
    const participantId = fill(x.db);
    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 7) throw new Error("synthetic v7 failure"); } }), /synthetic v7 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 6);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='participant_deletion_requests'").get().n, 0);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM registration_drafts").get().n, 1);

    const migrated = migrateDatabase(x.db);
    assert.deepEqual(migrated.applied.map((step) => step.version), [7]);
    assert.equal(x.db.pragma("user_version", { simple: true }), 7);
    assert.equal(inspectSchema(x.db, { allowKnownOptionalColumns: false }).version, 7);
    const columns = x.db.prepare("PRAGMA table_info(participant_deletion_requests)").all();
    assert.deepEqual(columns.map((column) => column.name), ["id", "request_id", "participant_id", "requested_at", "status"]);
    assert.ok(x.db.prepare("PRAGMA foreign_key_list(participant_deletion_requests)").all().some((fk) => fk.table === "participants" && fk.on_delete === "SET NULL"));
    assert.ok(x.db.prepare("PRAGMA index_list(participant_deletion_requests)").all().some((index) => index.name === "uq_participant_deletion_requests_active" && index.unique && index.partial));
    x.db.prepare("INSERT INTO participant_deletion_requests(request_id,participant_id,requested_at) VALUES('synthetic-request-1',?,'2026-10-20T00:00:00.000Z')").run(participantId);
    assert.throws(() => x.db.prepare("INSERT INTO participant_deletion_requests(request_id,participant_id,requested_at) VALUES('synthetic-request-2',?,'2026-10-20T00:01:00.000Z')").run(participantId), /UNIQUE/);
    const before = x.db.prepare("SELECT COUNT(*) AS n FROM participant_deletion_requests").get().n;
    assert.deepEqual(migrateDatabase(x.db).applied, []);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participant_deletion_requests").get().n, before);
    assert.equal(x.db.prepare("SELECT first_name FROM participants WHERE id=?").get(participantId).first_name, "ВымышленноеИмя");
  } finally { x.close(); }
});

test("неизвестная версия и несовместимая схема отклоняются без изменений", () => {
  const x = fixture({ version: 1 });
  try {
    x.db.pragma("user_version = 99");
    assert.throws(() => previewMigrations(x.db), /Неизвестная версия/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 99);
  } finally { x.close(); }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrations-unknown-"));
  const db = new Database(path.join(directory, "unknown.sqlite"));
  try {
    db.exec("CREATE TABLE participants (id INTEGER PRIMARY KEY, first_name TEXT); CREATE TABLE accounts (id INTEGER PRIMARY KEY); CREATE TABLE admins (telegram_id TEXT); CREATE TABLE registration_drafts (platform TEXT);");
    assert.throws(() => migrateDatabase(db), /Несовместимая схема|отсутствуют|Неизвестны|индексов/);
    assert.equal(db.pragma("user_version", { simple: true }), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='participants'").get().n, 1);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("неизвестный индекс и view отклоняются даже если основные таблицы есть или база выглядит пустой", () => {
  const indexed = fixture({ version: 1 });
  try {
    indexed.db.exec("CREATE INDEX extra_city_index ON participants(city)");
    assert.throws(() => previewMigrations(indexed.db), /индексов/);
    assert.throws(() => migrateDatabase(indexed.db), /индексов/);
    assert.equal(indexed.db.pragma("user_version", { simple: true }), 1);
  } finally { indexed.close(); }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrations-empty-view-"));
  const db = new Database(path.join(directory, "view.sqlite"));
  try {
    db.exec("CREATE VIEW unexpected_view AS SELECT 1 AS value");
    assert.throws(() => previewMigrations(db), /представления/);
    assert.throws(() => migrateDatabase(db), /представления/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("режим предварительной проверки миграции открывает существующий файл только для чтения", () => {
  const x = fixture({ version: 1 });
  try {
    const result = runMigrationCommand({ mode: "check", databasePath: x.file });
    assert.equal(result.preview.currentVersion, 1);
    assert.deepEqual(result.preview.plan.map((step) => step.version), [2, 3, 4, 5, 6, 7]);
    assert.equal(x.db.pragma("user_version", { simple: true }), 1);
    assert.equal(x.db.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_at"), false);
  } finally { x.close(); }
});

test("обычный импорт модуля не обновляет существующую старую базу автоматически", () => {
  const x = fixture({ version: 1 });
  x.db.close();
  try {
    const modulePath = path.resolve(__dirname, "../src/database/index.js");
    const child = spawnSync(process.execPath, ["-e", "require(process.env.MODULE_PATH)"], {
      env: { ...process.env, DB_PATH: x.file, MODULE_PATH: modulePath }, encoding: "utf8"
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /не обновляется автоматически|явную миграцию/);
    const check = new Database(x.file, { readonly: true, fileMustExist: true });
    try {
      assert.equal(check.pragma("user_version", { simple: true }), 1);
      assert.equal(check.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_at"), false);
    } finally { check.close(); }
  } finally { fs.rmSync(x.directory, { recursive: true, force: true }); }
});

test("CLI применяет только явно подтверждённую миграцию и не создаёт отсутствующий файл", () => {
  const x = fixture({ version: 1 });
  try {
    assert.throws(() => runMigrationCommand({ mode: "apply", databasePath: x.file }), /Подтверждение/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 1);
    const result = runMigrationCommand({ mode: "apply", databasePath: x.file, confirmation: x.file });
    assert.equal(result.schema.version, CURRENT_SCHEMA_VERSION);
  } finally { x.close(); }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-migrations-missing-"));
  const missing = path.join(directory, "missing.sqlite");
  try {
    assert.throws(() => runMigrationCommand({ mode: "check", databasePath: missing }), /не найден/);
    assert.equal(fs.existsSync(missing), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
