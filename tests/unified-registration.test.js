const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { makePhoneVerificationProof, makeConsentAttestation } = require("../src/registration-attestations");
const { createOwnContactProof } = require("../src/registration-adapters/telegram");

const databaseModulePath = path.resolve(__dirname, "../src/database/index.js");
const serviceModulePath = path.resolve(__dirname, "../src/participant-service.js");

function setup({ allowedPhoneMethods = { telegram: ["telegram_contact"] } } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-unified-registration-"));
  const savedEnv = Object.fromEntries(["DB_PATH", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "PHONE_PROOF_SECRET", "DEMO_MODE"].map(key => [key, process.env[key]]));
  const env = {
    DB_PATH: path.join(directory, "registration.sqlite"),
    PRIVACY_POLICY_URL: "https://policy.invalid/synthetic",
    PRIVACY_POLICY_VERSION: "synthetic-v1",
    PHONE_PROOF_SECRET: "synthetic-unified-registration-key-v1",
    DEMO_MODE: "false"
  };
  Object.assign(process.env, env);
  for (const modulePath of ["../src/database", "../src/participant-service"]) delete require.cache[require.resolve(modulePath)];
  const database = require("../src/database");
  const { createRegistrationService } = require("../src/participant-service");
  const clock = Date.now();
  const service = createRegistrationService({ database, envProvider: () => env, now: () => clock, allowedPhoneMethods });
  function submission(account, phone = "+79006660001", extra = {}) {
    const identity = { platform: account.platform, accountId: String(account.messenger_user_id) };
    const phoneConfirmedAt = new Date(clock).toISOString();
    const consentAt = new Date(clock).toISOString();
    const policy = service.getRegistrationPolicy();
    return {
      first_name: "СинтетическоеИмя",
      last_name: "ВымышленнаяФамилия",
      phone,
      phone_confirmed_at: phoneConfirmedAt,
      phone_confirmed_by: identity.accountId,
      phone_verification: makePhoneVerificationProof({ ...identity, phone, confirmedAt: phoneConfirmedAt, method: account.platform === "telegram" ? "telegram_contact" : "test_max_provider" }, env),
      city: null,
      email: null,
      preferred_contact: "Telegram",
      referral_source: null,
      personal_data_consent: true,
      consent_at: consentAt,
      consent_given_by: identity.accountId,
      consent_version: policy.version,
      policy_url: policy.url,
      policy_version: policy.version,
      consent_attestation: makeConsentAttestation({ ...identity, policyUrl: policy.url, policyVersion: policy.version, acceptedAt: consentAt }, env),
      ...extra
    };
  }
  return {
    directory, env, database, service, submission, clock,
    close() {
      try { database.closeDatabase(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      for (const modulePath of ["../src/database", "../src/participant-service"]) delete require.cache[require.resolve(modulePath)];
    }
  };
}

function account(platform, messenger_user_id) { return { platform, messenger_user_id: String(messenger_user_id) }; }

function beginLink(x, participantId, targetAccount, phone = "+79006660001") {
  const proof = x.submission(targetAccount, phone).phone_verification;
  return { proof, request: x.service.createAccountLinkRequest({ participantId, account: targetAccount, phoneVerification: proof }) };
}
function telegramDecision(x, telegram, requestId, action = "approve") {
  const ctx = { from: { id: Number(telegram.messenger_user_id) }, chat: { type: "private" }, callbackQuery: { from: { id: Number(telegram.messenger_user_id) }, data: `link:${action}:${requestId}` } };
  return x.service[`${action}AccountLinkRequestFromTelegram`](ctx, requestId);
}
function finishLink(x, requestId, target, proof) {
  return x.service.completeAccountLinkRequest({ requestId, account: target, phoneVerification: proof });
}

test("Telegram-регистрация создаёт одну анкету и повторный запрос идемпотентен", () => {
  const x = setup();
  try {
    const telegram = account("telegram", "700000101");
    const first = x.service.registerParticipant(x.submission(telegram), telegram);
    const second = x.service.registerParticipant(x.submission(telegram), telegram);
    assert.equal(first.status, "created");
    assert.equal(second.status, "already_registered");
    assert.equal(first.participant.id, second.participant.id);
    assert.equal(x.database.getParticipantCount(), 1);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 1);
  } finally { x.close(); }
});

test("подписанные подтверждения из черновика действуют после перезапуска SQLite", () => {
  const x = setup();
  try {
    const telegram = account("telegram", "700000105");
    const answers = x.submission(telegram);
    x.database.saveDraft("telegram", telegram.messenger_user_id, "confirm", answers);
    const savedPath = x.database.dbPath;
    x.database.closeDatabase();
    delete require.cache[require.resolve("../src/database")];
    delete require.cache[require.resolve("../src/participant-service")];
    const reopenedDatabase = require("../src/database");
    const { createRegistrationService } = require("../src/participant-service");
    const reopenedService = createRegistrationService({ database: reopenedDatabase, envProvider: () => x.env });
    const restored = reopenedDatabase.getDraft("telegram", telegram.messenger_user_id);
    assert.ok(fs.existsSync(savedPath));
    const result = reopenedService.registerParticipant(restored.answers, telegram);
    assert.equal(result.status, "created");
    assert.equal(reopenedDatabase.getParticipantCount(), 1);
    reopenedDatabase.closeDatabase();
  } finally { x.close(); }
});

test("совпавший подтверждённый телефон не раскрывает анкету и не связывает новый аккаунт автоматически", () => {
  const x = setup({ allowedPhoneMethods: { telegram: ["telegram_contact"], max: ["test_max_provider"] } });
  try {
    const telegram = account("telegram", "700000111");
    const max = account("max", "MAX-700000111");
    x.service.registerParticipant(x.submission(telegram), telegram);
    const proof = x.submission(max).phone_verification;
    assert.deepEqual(x.service.inspectVerifiedPhone(max, proof), { status: "account_confirmation_required" });
    assert.throws(() => x.service.registerParticipant(x.submission(max), max), error => error.code === "PHONE_ALREADY_REGISTERED");
    assert.equal(x.database.getParticipantCount(), 1);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 1);
  } finally { x.close(); }
});

test("связывание требует свежего подтверждения телефона и явного решения старого Telegram-аккаунта", () => {
  const x = setup({ allowedPhoneMethods: { telegram: ["telegram_contact"], max: ["test_max_provider"] } });
  try {
    const telegram = account("telegram", "700000121");
    const max = account("max", "MAX-700000121");
    const participant = x.service.registerParticipant(x.submission(telegram), telegram).participant;
    const phoneProof = x.submission(max).phone_verification;
    const { request } = beginLink(x, participant.id, max);
    assert.equal(request.status, "pending");
    assert.equal(telegramDecision(x, telegram, request.request_id).status, "approved");
    const linked = finishLink(x, request.request_id, max, phoneProof);
    assert.equal(linked.status, "linked");
    assert.equal(linked.participant_id, participant.id);
    assert.equal(x.database.getParticipantCount(), 1);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE participant_id=?").get(participant.id).count, 2);
    assert.equal(x.database.getParticipantStatistics().total, 1);
    const rows = x.database.getParticipantsForExport();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].telegram_id, telegram.messenger_user_id);
    assert.equal(rows[0].max_id, max.messenger_user_id);
  } finally { x.close(); }
});

test("аккаунт, уже связанный с другим участником, нельзя перетащить по тому же номеру", () => {
  const x = setup({ allowedPhoneMethods: { telegram: ["telegram_contact"], max: ["test_max_provider"] } });
  try {
    const telegramA = account("telegram", "700000131");
    const telegramB = account("telegram", "700000132");
    const max = account("max", "MAX-700000132");
    const participantA = x.service.registerParticipant(x.submission(telegramA, "+79006660001"), telegramA).participant;
    const participantB = x.service.registerParticipant(x.submission(telegramB, "+79006660002"), telegramB).participant;
    x.database.linkAccount(participantB.id, "max", max.messenger_user_id);
    const proof = x.submission(max, "+79006660001").phone_verification;
    assert.throws(() => x.service.createAccountLinkRequest({ participantId: participantA.id, account: max, phoneVerification: proof }), error => error.code === "ACCOUNT_LINK_CONFLICT");
    assert.equal(x.database.db.prepare("SELECT participant_id FROM accounts WHERE platform='max' AND messenger_user_id=?").get(max.messenger_user_id).participant_id, participantB.id);
  } finally { x.close(); }
});

test("отозванное согласие блокирует повторную регистрацию и связывание со второй платформой", () => {
  const x = setup({ allowedPhoneMethods: { telegram: ["telegram_contact"], max: ["test_max_provider"] } });
  try {
    const telegram = account("telegram", "700000141");
    const max = account("max", "MAX-700000141");
    const participant = x.service.registerParticipant(x.submission(telegram), telegram).participant;
    x.database.db.prepare("UPDATE participants SET personal_data_consent=0, consent_withdrawn_at=? WHERE id=?").run(new Date(x.clock).toISOString(), participant.id);
    const maxData = x.submission(max);
    assert.deepEqual(x.service.inspectVerifiedPhone(max, maxData.phone_verification), { status: "unavailable" });
    assert.throws(() => x.service.registerParticipant(maxData, max), error => error.code === "CONSENT_WITHDRAWN");
    assert.throws(() => x.service.createAccountLinkRequest({ participantId: participant.id, account: max, phoneVerification: maxData.phone_verification }), error => error.code === "CONSENT_WITHDRAWN");
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE platform='max'").get().count, 0);
  } finally { x.close(); }
});

test("клиентское verified:true, испорченная подпись, устаревший номер и неподдерживаемый MAX блокируются", () => {
  const x = setup();
  try {
    const telegram = account("telegram", "700000151");
    const valid = x.submission(telegram);
    assert.throws(() => x.service.validateRegistration({ ...valid, phone_verification: { verified: true, phone: valid.phone } }, telegram), error => error.code === "PHONE_PROOF_INVALID");
    assert.throws(() => x.service.validateRegistration({ ...valid, phone_verification: { ...valid.phone_verification, phone: "+79006669999" } }, telegram), error => error.code === "PHONE_PROOF_INVALID");
    assert.throws(() => x.service.validateRegistration({ ...valid, consent_attestation: { ...valid.consent_attestation, signature: "invalid-signature" } }, telegram), error => error.code === "CONSENT_ATTESTATION_INVALID");
    const staleProof = makePhoneVerificationProof({ platform: "telegram", accountId: telegram.messenger_user_id, phone: valid.phone, confirmedAt: new Date(x.clock - 24 * 60 * 60 * 1000 - 1).toISOString(), method: "telegram_contact" }, x.env);
    assert.throws(() => x.service.validateRegistration({ ...valid, phone_verification: staleProof, phone_confirmed_at: staleProof.confirmed_at }, telegram), error => error.code === "PHONE_PROOF_INVALID");

    const productionDefault = require("../src/participant-service").createRegistrationService({ database: x.database, envProvider: () => x.env, now: () => x.clock });
    const max = account("max", "MAX-UNSUPPORTED");
    const maxProof = makePhoneVerificationProof({ platform: "max", accountId: max.messenger_user_id, phone: valid.phone, confirmedAt: new Date(x.clock).toISOString(), method: "test_max_provider" }, x.env);
    assert.throws(() => productionDefault.inspectVerifiedPhone(max, maxProof), error => error.code === "PHONE_PROOF_INVALID");
    assert.equal(x.database.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("деморежим блокирует обе бизнес-операции создания и связывания аккаунтов", () => {
  const x = setup({ allowedPhoneMethods: { telegram: ["telegram_contact"], max: ["test_max_provider"] } });
  try {
    x.env.DEMO_MODE = "true";
    const telegram = account("telegram", "700000181");
    const max = account("max", "MAX-700000181");
    assert.throws(
      () => x.service.registerParticipant({}, telegram),
      error => error.code === "DEMO_MODE_REGISTRATION_DISABLED"
    );
    assert.throws(
      () => x.service.createAccountLinkRequest({ participantId: 1, account: max }),
      error => error.code === "DEMO_MODE_LINK_DISABLED"
    );
    assert.equal(x.database.getParticipantCount(), 0);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
  } finally { x.close(); }
});

test("Telegram-адаптер требует собственный контакт, а не пересланный чужой номер", () => {
  const x = setup();
  try {
    assert.throws(() => createOwnContactProof({ contact: { user_id: "700000161", phone_number: "+79006660001" }, telegramUserId: "700000162", normalizePhone: x.database.normalizePhone, env: x.env }), error => error.code === "TELEGRAM_CONTACT_NOT_OWNED");
    const proof = createOwnContactProof({ contact: { user_id: "700000161", phone_number: "+7 (900) 666-00-01" }, telegramUserId: "700000161", normalizePhone: x.database.normalizePhone, confirmedAt: new Date(x.clock).toISOString(), env: x.env });
    assert.equal(proof.phone, "+79006660001");
    assert.equal(proof.platform, "telegram");
  } finally { x.close(); }
});

test("два процесса регистрации через независимые SQLite-подключения создают только одну анкету", () => {
  const x = setup();
  try {
    const telegram = account("telegram", "700000171");
    const data = x.submission(telegram);
    const dbPath = x.database.dbPath;
    x.database.closeDatabase();
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      process.env.DB_PATH = workerData.dbPath;
      process.env.PRIVACY_POLICY_URL = workerData.env.PRIVACY_POLICY_URL;
      process.env.PRIVACY_POLICY_VERSION = workerData.env.PRIVACY_POLICY_VERSION;
      process.env.PHONE_PROOF_SECRET = workerData.env.PHONE_PROOF_SECRET;
      const service = require(workerData.serviceModulePath);
      parentPort.postMessage({ ready: true });
      parentPort.once('message', () => {
        try {
          const result = service.createRegistrationService().registerParticipant(workerData.data, workerData.account);
          parentPort.postMessage({ status: result.status, id: result.participant.id });
        } catch (error) { parentPort.postMessage({ error: error.code || error.name }); }
        finally { require(workerData.databaseModulePath).closeDatabase(); }
      });
    `;
    const childScript = `
      const { Worker } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const ids = [1,2];
      const source = ${JSON.stringify(workerSource)};
      function start() {
        const worker = new Worker(source, { eval: true, workerData: ${JSON.stringify({ dbPath, env: x.env, serviceModulePath, databaseModulePath, data, account: telegram })} });
        let readyResolve, resultResolve, resultReject;
        const ready = new Promise(resolve => readyResolve = resolve);
        const result = new Promise((resolve,reject) => { resultResolve=resolve; resultReject=reject; });
        worker.on('message', msg => msg.ready ? readyResolve() : resultResolve(msg));
        worker.on('error', resultReject);
        worker.on('exit', code => { if (code !== 0) resultReject(new Error('registration worker failed')); });
        return {worker,ready,result};
      }
      (async () => {
        const pair = ids.map(start);
        await Promise.all(pair.map(x => x.ready));
        pair.forEach(x => x.worker.postMessage('register'));
        const results = await Promise.all(pair.map(x => x.result));
        if (results.filter(x => x.status === 'created').length !== 1 || results.filter(x => x.status === 'already_registered').length !== 1) throw new Error('unexpected outcomes: '+JSON.stringify(results));
        if (results[0].id !== results[1].id) throw new Error('registration returned different participant IDs');
        const check = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        if (check.prepare('SELECT COUNT(*) AS n FROM participants').get().n !== 1) throw new Error('participant duplicate detected');
        if (check.prepare('SELECT COUNT(*) AS n FROM accounts').get().n !== 1) throw new Error('account duplicate detected');
        check.close();
      })().catch(error => { console.error(error.stack); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ["-e", childScript], { encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally { x.close(); }
});
