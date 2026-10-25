const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const Database = require("better-sqlite3");
const { createBackupManager, verifyBackupFile } = require("../src/database/backup");

const ENV_NAMES = ["DB_PATH", "DEMO_MODE", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION"];
const FIXED_NOW = new Date("2026-10-20T10:00:00.000Z");

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-participant-data-"));
  const previousEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.DB_PATH = path.join(directory, "temporary.sqlite");
  delete process.env.DEMO_MODE;
  for (const modulePath of ["../src/database", "../src/participant-data"]) delete require.cache[require.resolve(modulePath)];
  const db = require("../src/database");
  const { createParticipantDataService } = require("../src/participant-data");
  let tokenNumber = 0;
  const service = createParticipantDataService({
    db,
    now: () => new Date(FIXED_NOW),
    createToken: () => `synthetic-confirmation-token-${++tokenNumber}`
  });
  const createParticipant = (telegramId, phoneSuffix, extra = {}) => {
    const participant = db.addParticipant({
      first_name: "ТестовоеИмя",
      last_name: "ВымышленнаяФамилия",
      phone: `+999700000${String(phoneSuffix).padStart(2, "0")}`,
      phone_confirmed_at: "2026-10-19T10:00:00.000Z",
      personal_data_consent: true,
      consent_at: "2026-10-19T10:01:00.000Z",
      consent_version: "test-policy-v1",
      preferred_contact: "Telegram",
      ...extra
    }, { platform: "telegram", messenger_user_id: String(telegramId) });
    return participant;
  };
  return {
    directory, db, service, createParticipant,
    close() {
      service.stop();
      try { db.closeDatabase(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
      for (const name of ENV_NAMES) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
      for (const modulePath of ["../src/database", "../src/participant-data"]) delete require.cache[require.resolve(modulePath)];
    }
  };
}

test("предварительный просмотр и удаление анкеты чистят связанные записи, а старые и новые снимки ведут себя ожидаемо", async () => {
  const x = setup();
  try {
    const first = x.createParticipant("700000001", 1);
    const second = x.createParticipant("700000002", 2);
    x.db.db.prepare("INSERT INTO admins(telegram_id,role) VALUES(?,?)").run("700000003", "admin");
    x.db.linkAccount(first.id, "max", "DEMO-MAX-700000001");
    x.db.saveDraft("telegram", "700000001", "email", { synthetic: true });
    x.db.saveDraft("max", "DEMO-MAX-700000001", "email", { synthetic: true });
    x.db.saveDraft("telegram", "unrelated-draft", "first_name", { synthetic: true });
    const withdrawal = x.service.prepareOwnConsentWithdrawal("700000001");
    assert.equal(x.service.confirmOwnConsentWithdrawal("700000001", withdrawal.confirmation_token).status, "received");
    const backupManager = createBackupManager({
      sourceDb: x.db.db,
      sourcePath: x.db.dbPath,
      backupDir: path.join(x.directory, "snapshots"),
      retentionCount: 10
    });
    const oldBackup = await backupManager.createBackup();

    const prepared = x.service.prepareOwnDeletion("700000001");
    assert.equal(prepared.status, "confirmation_required");
    assert.deepEqual(prepared.impact, {
      participant_id: first.id,
      participant_records: 1,
      linked_accounts: ["max", "telegram"],
      registration_drafts: 2,
      consent_withdrawal_requests: 1
    });
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 2, "предварительный просмотр не удаляет анкету");
    assert.equal(JSON.stringify(prepared.impact).includes("ТестовоеИмя"), false, "предварительный просмотр не раскрывает анкетные данные");

    const result = x.service.confirmOwnDeletion("700000001", prepared.confirmation_token);
    assert.equal(result.status, "deleted");
    assert.equal(result.impact.accounts_deleted, 2);
    assert.equal(result.impact.registration_drafts_deleted, 2);
    assert.equal(result.impact.withdrawal_requests_deleted, 1);
    assert.equal(x.db.getParticipant(first.id), undefined);
    assert.equal(x.db.findParticipantByTelegramId("700000001"), undefined);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE participant_id=?").get(first.id).count, 0);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM registration_drafts WHERE messenger_user_id IN (?,?)").get("700000001", "DEMO-MAX-700000001").count, 0);
    assert.equal(x.db.hasDraft("telegram", "unrelated-draft"), true);
    assert.equal(x.db.getParticipant(second.id).first_name, "ТестовоеИмя");
    assert.equal(x.db.getAdminRole("700000003"), "admin", "удаление участника не затрагивает таблицу администраторов");
    assert.equal(x.db.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(x.db.searchParticipants("ТестовоеИмя").length, 1);
    assert.equal(x.db.getParticipantStatistics().total, 1);
    assert.equal(x.db.getParticipantsForExport().length, 1);
    const newBackup = await backupManager.createBackup();
    assert.equal(verifyBackupFile(oldBackup.path, { requireMetadata: true }), true);
    assert.equal(verifyBackupFile(newBackup.path, { requireMetadata: true }), true);
    const oldSnapshotDb = new Database(oldBackup.path, { readonly: true, fileMustExist: true });
    const newSnapshotDb = new Database(newBackup.path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(oldSnapshotDb.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 2);
      assert.equal(newSnapshotDb.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 1);
    } finally { oldSnapshotDb.close(); newSnapshotDb.close(); }
  } finally { x.close(); }
});

test("чужой аккаунт, истёкшее подтверждение и повторное удаление не удаляют участника", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000011", 11);
    const prepared = x.service.prepareOwnDeletion("700000011");
    assert.equal(x.service.confirmOwnDeletion("700000012", prepared.confirmation_token).status, "invalid_or_expired_confirmation");
    assert.equal(x.db.getParticipant(participant.id).id, participant.id);
    assert.equal(x.service.confirmOwnDeletion("700000011", prepared.confirmation_token).status, "deleted");
    assert.equal(x.service.confirmOwnDeletion("700000011", prepared.confirmation_token).status, "invalid_or_expired_confirmation");
    assert.equal(x.service.prepareOwnDeletion("700000011").status, "not_found");
  } finally { x.close(); }
});

test("сбой удаления участника откатывает удаление связанных черновиков и аккаунтов", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000021", 21);
    x.db.saveDraft("telegram", "700000021", "city", { synthetic: true });
    x.db.createParticipantDeletionRequestForTelegram("700000021", "00000000-0000-4000-8000-000000000021", FIXED_NOW.toISOString());
    x.db.db.exec("CREATE TRIGGER reject_test_participant_delete BEFORE DELETE ON participants BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END");
    assert.throws(() => x.db.deleteParticipantById(participant.id), /synthetic delete failure/);
    assert.equal(x.db.getParticipant(participant.id).id, participant.id);
    assert.equal(x.db.findParticipantByTelegramId("700000021").id, participant.id);
    assert.equal(x.db.hasDraft("telegram", "700000021"), true);
    assert.equal(x.db.db.prepare("SELECT status FROM participant_deletion_requests WHERE participant_id=?").get(participant.id).status, "pending_review");
  } finally { x.close(); }
});

test("повторный запрос удаления разрешён после processed и not_applicable, но не при активном запросе", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000025", 25);
    const first = x.db.createParticipantDeletionRequestForTelegram("700000025", "00000000-0000-4000-8000-000000000025", FIXED_NOW.toISOString());
    assert.equal(first.status, "received");
    assert.equal(x.db.createParticipantDeletionRequestForTelegram("700000025", "00000000-0000-4000-8000-000000000026", "2026-10-20T10:01:00.000Z").status, "already_requested");
    x.db.db.prepare("UPDATE participant_deletion_requests SET status='processed' WHERE request_id=?").run(first.request_id);
    const second = x.db.createParticipantDeletionRequestForTelegram("700000025", "00000000-0000-4000-8000-000000000027", "2026-10-20T10:02:00.000Z");
    assert.equal(second.status, "received");
    x.db.db.prepare("UPDATE participant_deletion_requests SET status='not_applicable' WHERE request_id=?").run(second.request_id);
    const third = x.db.createParticipantDeletionRequestForTelegram("700000025", "00000000-0000-4000-8000-000000000028", "2026-10-20T10:03:00.000Z");
    assert.equal(third.status, "received");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests WHERE participant_id=?").get(participant.id).count, 3);
  } finally { x.close(); }
});

test("два независимых SQLite-подключения не создают одновременно два активных запроса", async () => {
  const x = setup();
  const workers = [];
  try {
    x.createParticipant("700000029", 29);
    const start = new SharedArrayBuffer(4);
    const workerCode = `
      const { parentPort, workerData } = require("node:worker_threads");
      process.env.DB_PATH = workerData.dbPath;
      const database = require(workerData.modulePath);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.start), 0, 0);
      try {
        const result = database.createParticipantDeletionRequestForTelegram(workerData.telegramId, workerData.requestId, "2026-10-20T10:10:00.000Z");
        parentPort.postMessage({ status: result.status });
      } catch (error) { parentPort.postMessage({ error: error.code || error.message }); }
      finally { database.closeDatabase(); }
    `;
    const results = [];
    const ready = [];
    for (let i = 0; i < 2; i += 1) {
      const worker = new Worker(workerCode, { eval: true, workerData: {
        dbPath: x.db.dbPath,
        modulePath: require.resolve("../src/database"),
        telegramId: "700000029",
        requestId: `00000000-0000-4000-8000-${String(i + 29).padStart(12, "0")}`,
        start
      } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        worker.once("message", (message) => message.ready ? resolve() : reject(new Error("SQLite worker did not become ready")));
        worker.once("error", reject);
      }));
      results.push(new Promise((resolve, reject) => {
        worker.on("message", (message) => { if (message.status || message.error) resolve(message); });
        worker.once("error", reject);
      }));
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(start), 0, 1);
    Atomics.notify(new Int32Array(start), 0, 2);
    const outcomes = await Promise.all(results);
    assert.deepEqual(outcomes.map((value) => value.status).sort(), ["already_requested", "received"]);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests WHERE status='pending_review'").get().count, 1);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    x.close();
  }
});

test("успешное удаление анкеты завершает запрос и оставляет только обезличенную историю", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000030", 30);
    x.db.linkAccount(participant.id, "max", "DEMO-ACCOUNT-030");
    x.db.saveDraft("telegram", "700000030", "city", { synthetic: true });
    const created = x.db.createParticipantDeletionRequestForTelegram("700000030", "00000000-0000-4000-8000-000000000030", FIXED_NOW.toISOString());
    assert.equal(created.status, "received");

    const result = x.db.deleteParticipantById(participant.id);
    assert.equal(result.deleted, true);
    assert.equal(result.deletion_requests_processed, 1);
    assert.equal(x.db.getParticipant(participant.id), undefined);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE participant_id=?").get(participant.id).count, 0);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM registration_drafts WHERE messenger_user_id='700000030'").get().count, 0);
    const request = x.db.db.prepare("SELECT request_id,participant_id,requested_at,status FROM participant_deletion_requests WHERE request_id=?").get(created.request_id);
    assert.deepEqual(request, { request_id: created.request_id, participant_id: null, requested_at: FIXED_NOW.toISOString(), status: "processed" });
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests WHERE status='pending_review'").get().count, 0);

    const repeated = x.db.deleteParticipantById(participant.id);
    assert.equal(repeated.deleted, false);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests WHERE status='pending_review'").get().count, 0);
    assert.equal(x.db.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { x.close(); }
});

test("удаление участника администратором требует прав при подготовке и подтверждении", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000031", 31);
    x.db.db.prepare("INSERT INTO admins(telegram_id,role) VALUES(?,?)").run("700000032", "admin");
    assert.throws(() => x.service.prepareAdminDeletion("700000099", participant.id), /Недостаточно административных прав/);
    const prepared = x.service.prepareAdminDeletion("700000032", participant.id);
    assert.equal(prepared.status, "confirmation_required");
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run("700000032");
    assert.throws(() => x.service.confirmAdminDeletion("700000032", prepared.confirmation_token), /Административные права отозваны/);
    assert.equal(x.db.getParticipant(participant.id).id, participant.id);
  } finally { x.close(); }
});

test("запрос отзыва согласия связан с собственным аккаунтом, немедленно блокирует согласие и повторяем", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000041", 41);
    const prepared = x.service.prepareOwnConsentWithdrawal("700000041");
    assert.equal(prepared.status, "confirmation_required");
    assert.equal(x.service.confirmOwnConsentWithdrawal("700000042", prepared.confirmation_token).status, "invalid_or_expired_confirmation");
    const result = x.service.confirmOwnConsentWithdrawal("700000041", prepared.confirmation_token);
    assert.equal(result.status, "received");
    assert.equal(result.processing_based_on_consent_allowed, false);
    const consent = x.service.getConsentState(participant.id);
    assert.equal(consent.personal_data_consent, 0);
    assert.equal(consent.active, false);
    assert.equal(consent.processing_based_on_consent_allowed, false);
    assert.ok(consent.consent_withdrawn_at);
    assert.equal(x.db.getConsentWithdrawalRequest(result.request_id).status, "pending_review");
    assert.equal(x.service.prepareOwnConsentWithdrawal("700000041").status, "already_requested");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM consent_withdrawal_requests WHERE participant_id=?").get(participant.id).count, 1);
    assert.equal(x.db.getParticipant(participant.id), undefined, "обычные функции не раскрывают запись после отзыва");
    assert.equal(x.db.findParticipantByTelegramId("700000041"), undefined);
    assert.equal(x.db.searchParticipants("ТестовоеИмя").length, 0);
    assert.equal(x.db.listParticipants().length, 0);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getParticipantStatistics().total, 0);
    assert.equal(x.db.getParticipantsForExport().length, 0);
    assert.equal(x.db.getParticipantIncludingWithdrawn(participant.id).phone, "+99970000041", "внутреннее хранилище сохраняет запись для рассмотрения, без автоматического удаления");
    assert.equal(x.db.updateParticipant(participant.id, { city: "Новый город" }), undefined);
    assert.throws(() => x.db.updatePhoneFromVerifiedTelegramContact("700000041", { user_id: 700000041, phone_number: "+999700000099" }), /не найдена/);
    assert.throws(() => x.db.linkAccount(participant.id, "max", "DEMO-MAX-700000041"), /Анкета недоступна/);
  } finally { x.close(); }
});

test("старое подтверждение отзыва не отзывает новое согласие", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000051", 51);
    const prepared = x.service.prepareOwnConsentWithdrawal("700000051");
    const nextConsentAt = "2026-10-20T09:59:00.000Z";
    x.db.db.prepare("UPDATE participants SET personal_data_consent=1, consent_at=?, consent_version=? WHERE id=?").run(nextConsentAt, "test-policy-v2", participant.id);
    const result = x.service.confirmOwnConsentWithdrawal("700000051", prepared.confirmation_token);
    assert.equal(result.status, "stale_confirmation");
    assert.equal(x.service.getConsentState(participant.id).active, true);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM consent_withdrawal_requests WHERE participant_id=?").get(participant.id).count, 0);
  } finally { x.close(); }
});

test("владелец может обработать запрос отзыва, а повторная обработка безопасна", () => {
  const x = setup();
  try {
    const participant = x.createParticipant("700000061", 61);
    const prepared = x.service.prepareOwnConsentWithdrawal("700000061");
    const request = x.service.confirmOwnConsentWithdrawal("700000061", prepared.confirmation_token);
    assert.throws(() => x.service.resolveConsentWithdrawal("700000099", request.request_id, "processed"), /Недостаточно административных прав/);
    x.db.db.prepare("INSERT INTO admins(telegram_id,role) VALUES(?,?)").run("700000062", "owner");
    assert.equal(x.service.resolveConsentWithdrawal("700000062", request.request_id, "processed").status, "processed");
    assert.equal(x.service.resolveConsentWithdrawal("700000062", request.request_id, "processed").status, "already_resolved");
    assert.equal(x.db.getConsentWithdrawalRequest(request.request_id).status, "processed");
    assert.equal(x.db.getParticipantConsentState(participant.id).active, false);
  } finally { x.close(); }
});

test("телефон нельзя поменять текстом, чужим контактом или на занятый номер", () => {
  const x = setup();
  try {
    const first = x.createParticipant("700000071", 71);
    x.createParticipant("700000072", 72);
    assert.throws(() => x.db.updatePhoneFromVerifiedTelegramContact("700000071", "+99970000073"), /собственного контакта/);
    assert.throws(() => x.db.updatePhoneFromVerifiedTelegramContact("700000071", { user_id: 700000072, phone_number: "+99970000073" }), /собственного контакта/);
    assert.throws(() => x.db.updatePhoneFromVerifiedTelegramContact("700000071", { user_id: 700000071, phone_number: "+99970000072" }), /UNIQUE|unique/);
    assert.equal(x.db.getParticipant(first.id).phone, "+99970000071");
    const updated = x.db.updatePhoneFromVerifiedTelegramContact("700000071", { user_id: 700000071, phone_number: "+999 700 000 073" }, "2026-10-20T09:00:00.000Z");
    assert.equal(updated.phone, "+999700000073");
    assert.equal(updated.phone_confirmed_at, "2026-10-20T09:00:00.000Z");
  } finally { x.close(); }
});

