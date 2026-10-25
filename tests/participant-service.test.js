const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createBaseSchema, migrateDatabase } = require("../src/database/migrations");
const { makePhoneVerificationProof, makeConsentAttestation } = require("../src/registration-attestations");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-participant-service-"));
  process.env.DB_PATH = path.join(dir, "temporary.sqlite");
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "approved-test-version";
  process.env.PRIVACY_POLICY_PUBLISHED = "true";
  process.env.PHONE_PROOF_SECRET = "synthetic-participant-service-secret-v1";
  delete process.env.DEMO_MODE;
  delete require.cache[require.resolve("../src/database")];
  delete require.cache[require.resolve("../src/participant-service")];
  const db = require("../src/database");
  const service = require("../src/participant-service");
  const policy = service.getRegistrationPolicy();
  const phoneConfirmedAt = new Date().toISOString();
  const consentAt = new Date().toISOString();
  const answers = {
    first_name: "ТестовоеИмя", last_name: "ТестоваяФамилия", phone: "+79005550001",
    phone_confirmed_at: phoneConfirmedAt, phone_confirmed_by: "test-user-1",
    phone_verification: makePhoneVerificationProof({ platform: "telegram", accountId: "test-user-1", phone: "+79005550001", confirmedAt: phoneConfirmedAt, method: "telegram_contact" }), city: null, email: null,
    preferred_contact: "Telegram", referral_source: null,
    personal_data_consent: true, consent_at: consentAt, consent_given_by: "test-user-1",
    consent_version: policy.version, policy_url: policy.url, policy_version: policy.version
  };
  answers.consent_attestation = makeConsentAttestation({ platform: "telegram", accountId: "test-user-1", policyUrl: policy.url, policyVersion: policy.version, acceptedAt: consentAt });
  return {
    dir, db, service, answers,
    close() {
      db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true });
      for (const key of ["DB_PATH", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "PRIVACY_POLICY_PUBLISHED", "PHONE_PROOF_SECRET", "DEMO_MODE"]) delete process.env[key];
      delete require.cache[require.resolve("../src/database")];
      delete require.cache[require.resolve("../src/participant-service")];
    }
  };
}

test("центральная проверка сохраняет валидную анкету, дату и версию согласия", () => {
  const x = setup(); try {
    const participant = x.service.createRegisteredParticipant(x.answers, { platform: "telegram", messenger_user_id: "test-user-1" });
    assert.equal(participant.first_name, "ТестовоеИмя");
    assert.equal(participant.personal_data_consent, 1);
    assert.equal(participant.consent_at, x.answers.consent_at);
    assert.equal(participant.consent_version, "approved-test-version");
    assert.equal(x.db.findParticipantByTelegramId("test-user-1").id, participant.id);
  } finally { x.close(); }
});

test("центральная проверка блокирует поддельное подтверждение телефона и отсутствие согласия", () => {
  const x = setup(); try {
    const account = { platform: "telegram", messenger_user_id: "test-user-1" };
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, phone_confirmed_at: null }, account), /Телефон не подтверждён/);
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, personal_data_consent: false }, account), /Нет согласия/);
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, consent_at: null }, account), /дата и время согласия/);
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, consent_version: "other-version" }, account), /другой версии политики/);
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, first_name: " " }, account), /Имя обязательно/);
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, phone_confirmed_by: "another-user" }, account), /этим аккаунтом доверенным способом/);
    assert.throws(() => x.service.createRegisteredParticipant({ ...x.answers, consent_given_by: "another-user" }, account), /Согласие не подтверждено этим аккаунтом/);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("единая проверка соблюдает пределы полей и зависимость email от способа связи", () => {
  const x = setup(); try {
    const answer = { ...x.answers, first_name: "И".repeat(100), last_name: "Ф".repeat(100), city: "Г".repeat(100), email: `${"a".repeat(248)}@x.com`, referral_source: "И".repeat(120) };
    const valid = x.service.validateRegistration(answer, x.service.getRegistrationPolicy(), { platform: "telegram", messenger_user_id: "test-user-1" });
    assert.equal(valid.first_name.length, 100); assert.equal(valid.last_name.length, 100);
    assert.equal(valid.city.length, 100);
    assert.equal(valid.email.length, 254);
    assert.equal(valid.referral_source.length, 120);
    assert.throws(() => x.service.validateRegistration({ ...answer, city: "Г".repeat(101) }, x.service.getRegistrationPolicy(), { platform: "telegram", messenger_user_id: "test-user-1" }), /Город.*100/);
    assert.throws(() => x.service.validateRegistration({ ...answer, referral_source: "И".repeat(121) }, x.service.getRegistrationPolicy(), { platform: "telegram", messenger_user_id: "test-user-1" }), /Источник знакомства.*120/);
    assert.throws(() => x.service.validateRegistration({ ...answer, email: "a".repeat(249) + "@x.com" }, x.service.getRegistrationPolicy(), { platform: "telegram", messenger_user_id: "test-user-1" }), /Email.*254/);
    assert.throws(() => x.service.validateRegistration({ ...answer, email: "не email" }, x.service.getRegistrationPolicy(), { platform: "telegram", messenger_user_id: "test-user-1" }), /корректный email/);
    assert.throws(() => x.service.validateRegistration({ ...answer, email: null, preferred_contact: "Электронная почта" }, x.service.getRegistrationPolicy(), { platform: "telegram", messenger_user_id: "test-user-1" }), /email/i);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("отсутствие утверждённой версии политики блокирует реальное сохранение", () => {
  const x = setup(); try {
    delete process.env.PRIVACY_POLICY_VERSION;
    assert.throws(() => x.service.createRegisteredParticipant(x.answers, { platform: "telegram", messenger_user_id: "test-user-1" }), /PRIVACY_POLICY_VERSION/);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("деморежим запрещает запись даже при корректной политике и заполненной анкете", () => {
  const x = setup(); try {
    process.env.DEMO_MODE = "true";
    assert.throws(() => x.service.createRegisteredParticipant(x.answers, { platform: "telegram", messenger_user_id: "test-user-1" }), /отключена в демонстрационном режиме/);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.findParticipantByTelegramId("demo-user"), undefined);
  } finally { x.close(); }
});

test("явная миграция распознанной старой схемы добавляет поля согласия без потери участника", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-legacy-db-"));
  const file = path.join(dir, "legacy.sqlite");
  const legacy = new Database(file);
  try {
    legacy.pragma("foreign_keys = ON");
    createBaseSchema(legacy);
    legacy.pragma("user_version = 1");
    legacy.prepare("INSERT INTO participants(first_name,phone) VALUES(?,?)").run("СтарыйТест", "+79005550002");
    migrateDatabase(legacy);
    const columns = legacy.prepare("PRAGMA table_info(participants)").all().map((column) => column.name);
    assert.ok(columns.includes("consent_version"));
    assert.ok(columns.includes("consent_at"));
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 1);
    assert.equal(legacy.prepare("SELECT first_name FROM participants WHERE id=1").get().first_name, "СтарыйТест");
  } finally { legacy.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

