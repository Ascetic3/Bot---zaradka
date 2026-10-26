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
    assert.deepEqual(result.applied.map((step) => step.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
    assert.deepEqual(preview.plan.map((step) => step.version), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
    assert.deepEqual(preview.plan.map((step) => step.version), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const result = migrateDatabase(x.db);
    assert.deepEqual(result.applied.map((step) => step.version), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
    assert.deepEqual(preview.plan.map((step) => step.version), [5, 6, 7, 8, 9, 10, 11]);
    const result = migrateDatabase(x.db);
    assert.equal(result.stampedVersion, true);
    assert.deepEqual(result.applied.map((step) => step.version), [5, 6, 7, 8, 9, 10, 11]);
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
    assert.throws(() => migrateDatabase(x.db, { targetVersion: 7, beforeVersionCommit(version) { if (version === 7) throw new Error("synthetic v7 failure"); } }), /synthetic v7 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 6);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='participant_deletion_requests'").get().n, 0);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM admins").get().n, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM registration_drafts").get().n, 1);

    const migrated = migrateDatabase(x.db, { targetVersion: 7 });
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
    assert.deepEqual(migrateDatabase(x.db, { targetVersion: 7 }).applied, []);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participant_deletion_requests").get().n, before);
    assert.equal(x.db.prepare("SELECT first_name FROM participants WHERE id=?").get(participantId).first_name, "ВымышленноеИмя");
  } finally { x.close(); }
});

test("миграция v8 перестраивает фактическую схему v7 и сохраняет историю запросов", () => {
  const x = fixture({ version: 1 });
  try {
    const participantIds = [fill(x.db)];
    for (const suffix of [2, 3]) {
      const result = x.db.prepare("INSERT INTO participants(first_name,last_name,phone) VALUES(?,?,?)")
        .run("ВымышленноеИмя", "ТестоваяФамилия", `+9997000000${suffix}`);
      participantIds.push(Number(result.lastInsertRowid));
    }
    migrateDatabase(x.db, { targetVersion: 7 });
    const insert = x.db.prepare("INSERT INTO participant_deletion_requests(request_id,participant_id,requested_at,status) VALUES(?,?,?,?)");
    insert.run("synthetic-v7-pending", participantIds[0], "2026-10-20T10:00:00.000Z", "pending_review");
    insert.run("synthetic-v7-processed", participantIds[1], "2026-10-20T10:01:00.000Z", "processed");
    insert.run("synthetic-v7-na", participantIds[2], "2026-10-20T10:02:00.000Z", "not_applicable");
    const before = x.db.prepare("SELECT id,request_id,participant_id,requested_at,status FROM participant_deletion_requests ORDER BY id").all();

    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 8) throw new Error("synthetic v8 failure"); } }), /synthetic v8 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 7);
    assert.deepEqual(x.db.prepare("SELECT id,request_id,participant_id,requested_at,status FROM participant_deletion_requests ORDER BY id").all(), before);
    assert.ok(x.db.pragma("index_list(participant_deletion_requests)").some((index) => index.unique && !index.partial && x.db.pragma(`index_info(${JSON.stringify(index.name)})`).some((column) => column.name === "participant_id")));

    const migrated = migrateDatabase(x.db, { targetVersion: 8 });
    assert.deepEqual(migrated.applied.map((step) => step.version), [8]);
    assert.equal(x.db.pragma("user_version", { simple: true }), 8);
    assert.deepEqual(x.db.prepare("SELECT id,request_id,participant_id,requested_at,status FROM participant_deletion_requests ORDER BY id").all(), before);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 3);
    const indexes = x.db.pragma("index_list(participant_deletion_requests)");
    assert.equal(indexes.some((index) => index.unique && !index.partial && x.db.pragma(`index_info(${JSON.stringify(index.name)})`).some((column) => column.name === "participant_id")), false);
    assert.ok(indexes.some((index) => index.name === "uq_participant_deletion_requests_active" && index.unique && index.partial));
    assert.ok(indexes.some((index) => index.name === "idx_participant_deletion_requests_status" && !index.unique));
    assert.ok(x.db.pragma("foreign_key_list(participant_deletion_requests)").some((fk) => fk.table === "participants" && fk.from === "participant_id" && fk.to === "id" && fk.on_delete === "SET NULL"));
    assert.equal(x.db.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(x.db.pragma("foreign_key_check").length, 0);
    assert.deepEqual(migrateDatabase(x.db, { targetVersion: 8 }).applied, []);

    insert.run("synthetic-v8-new-after-processed", participantIds[1], "2026-10-20T10:03:00.000Z", "pending_review");
    assert.throws(() => insert.run("synthetic-v8-duplicate-active", participantIds[1], "2026-10-20T10:04:00.000Z", "pending_review"), /UNIQUE/);
  } finally { x.close(); }
});

test("миграция v9 добавляет маркеры только для тестовых участников и откатывается атомарно", () => {
  const x = fixture({ version: 1 });
  try {
    const participantId = fill(x.db);
    migrateDatabase(x.db, { targetVersion: 8 });
    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 9) throw new Error("synthetic v9 failure"); } }), /synthetic v9 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 8);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='demo_test_participants'").get().n, 0);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 1);
    const result = migrateDatabase(x.db, { targetVersion: 9 });
    assert.deepEqual(result.applied.map((step) => step.version), [9]);
    const schema = inspectSchema(x.db);
    assert.equal(schema.version, 9);
    assert.ok(x.db.pragma("foreign_key_list(demo_test_participants)").some((fk) => fk.table === "participants" && fk.from === "participant_id" && fk.on_delete === "CASCADE"));
    assert.ok(x.db.pragma("index_list(demo_test_participants)").some((index) => index.name === "idx_demo_test_participants_created_at" && !index.unique));
    x.db.prepare("INSERT INTO demo_test_participants(participant_id) VALUES(?)").run(participantId);
    assert.throws(() => x.db.prepare("INSERT INTO demo_test_participants(participant_id) VALUES(?)").run(participantId), /UNIQUE/);
    x.db.prepare("DELETE FROM participants WHERE id=?").run(participantId);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    assert.equal(x.db.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(x.db.pragma("foreign_key_check").length, 0);
    assert.deepEqual(migrateDatabase(x.db, { targetVersion: 9 }).applied, []);
  } finally { x.close(); }
});

test("миграция v10 создаёт таблицы рассылок; v11 добавляет общий лимитер атомарно", () => {
  const x = fixture({ version: 1 });
  try {
    fill(x.db);
    migrateDatabase(x.db, { targetVersion: 9 });
    assert.throws(() => migrateDatabase(x.db, { targetVersion: 10, beforeVersionCommit(version) { if (version === 10) throw new Error("synthetic v10 failure"); } }), /synthetic v10 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 9);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='meetings'").get().n, 0);
    migrateDatabase(x.db, { targetVersion: 10 });
    assert.equal(x.db.pragma("user_version", { simple: true }), 10);
    assert.equal(inspectSchema(x.db).version, 10);
    assert.throws(() => migrateDatabase(x.db, { beforeVersionCommit(version) { if (version === 11) throw new Error("synthetic v11 failure"); } }), /synthetic v11 failure/);
    assert.equal(x.db.pragma("user_version", { simple: true }), 10, "ошибка v11 должна откатить DDL и метку версии");
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='meeting_send_rate_limit_state'").get().n, 0);
    const result = migrateDatabase(x.db);
    assert.deepEqual(result.applied.map((step) => step.version), [11]);
    assert.equal(x.db.pragma("user_version", { simple: true }), 11);
    assert.equal(inspectSchema(x.db).version, 11);
    assert.deepEqual(x.db.prepare("SELECT singleton_id,next_allowed_at,blocked_until FROM meeting_send_rate_limit_state").get(), { singleton_id: 1, next_allowed_at: null, blocked_until: null });
    assert.deepEqual(x.db.prepare("SELECT sender_token,sender_pid,sender_host,sender_delivery_id,sender_acquired_at FROM meeting_send_rate_limit_state").get(),
      { sender_token: null, sender_pid: null, sender_host: null, sender_delivery_id: null, sender_acquired_at: null });
    assert.throws(() => x.db.prepare("INSERT INTO meeting_send_rate_limit_state(singleton_id) VALUES(2)").run(), /CHECK/);
    assert.equal(inspectSchema(x.db).version, 11);
    assert.equal(x.db.prepare("PRAGMA index_list(meeting_broadcasts)").all().some((index) => index.name === "idx_meeting_broadcasts_due"), true);
    assert.equal(x.db.prepare("PRAGMA index_list(meeting_deliveries)").all().some((index) => index.name === "uq_meeting_deliveries_recipient" && index.unique), true);
    assert.equal(x.db.prepare("PRAGMA foreign_key_list(meeting_deliveries)").all().some((fk) => fk.table === "participants" && fk.on_delete === "SET NULL"), true);
    const deliveryTableSql = x.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='meeting_deliveries'").get().sql;
    assert.match(deliveryTableSql, /'uncertain'/, "v10 допускает явное состояние неопределённой отправки");
    assert.throws(() => x.db.prepare("INSERT INTO meeting_broadcasts(meeting_id,status,scheduled_at,timezone,created_by) VALUES(1,'bogus','2030-01-01T00:00:00Z','Etc/UTC','700000001')").run(), /CHECK/);
    assert.equal(x.db.pragma("foreign_key_check").length, 0);
    assert.equal(x.db.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(x.db.pragma("user_version", { simple: true }), 11);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='meeting_notification_consents'").get().count, 0);
    assert.deepEqual(migrateDatabase(x.db).applied, []);
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
    assert.deepEqual(result.preview.plan.map((step) => step.version), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

