const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { makePhoneVerificationProof, makeConsentAttestation } = require("../src/registration-attestations");

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-account-link-"));
  const envKeys = ["DB_PATH", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "PHONE_PROOF_SECRET", "DEMO_MODE"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const env = {
    DB_PATH: path.join(directory, "protocol.sqlite"),
    PRIVACY_POLICY_URL: "https://policy.invalid/link-test",
    PRIVACY_POLICY_VERSION: "fictional-link-v1",
    PHONE_PROOF_SECRET: "fictional-link-test-key-at-least-32",
    DEMO_MODE: "false"
  };
  Object.assign(process.env, env);
  for (const modulePath of ["../src/database", "../src/participant-service"]) delete require.cache[require.resolve(modulePath)];
  const database = require("../src/database");
  const { createRegistrationService } = require("../src/participant-service");
  const clock = Date.now();
  const allowedPhoneMethods = { telegram: ["telegram_contact"], max: ["test_max_provider"] };
  const service = createRegistrationService({ database, envProvider: () => env, now: () => clock, allowedPhoneMethods });
  const oldAccount = { platform: "telegram", messenger_user_id: "780000001" };
  const phone = "+79007770001";
  const timestamp = new Date(clock).toISOString();
  const phoneVerification = makePhoneVerificationProof({ platform: "telegram", accountId: oldAccount.messenger_user_id, phone, confirmedAt: timestamp, method: "telegram_contact" }, env);
  const consent = makeConsentAttestation({ platform: "telegram", accountId: oldAccount.messenger_user_id, policyUrl: env.PRIVACY_POLICY_URL, policyVersion: env.PRIVACY_POLICY_VERSION, acceptedAt: timestamp }, env);
  const registered = service.registerParticipant({
    first_name: "ВымышленноеИмя", last_name: "ТестоваяФамилия", phone,
    phone_confirmed_at: timestamp, phone_confirmed_by: oldAccount.messenger_user_id, phone_verification: phoneVerification,
    city: null, email: null, preferred_contact: "Telegram", referral_source: null,
    personal_data_consent: true, consent_at: timestamp, consent_given_by: oldAccount.messenger_user_id,
    consent_version: env.PRIVACY_POLICY_VERSION, policy_url: env.PRIVACY_POLICY_URL,
    policy_version: env.PRIVACY_POLICY_VERSION, consent_attestation: consent
  }, oldAccount);
  function targetProof(target = { platform: "max", messenger_user_id: "MAX-FICTIONAL-1" }, targetPhone = phone) {
    return makePhoneVerificationProof({ platform: target.platform, accountId: target.messenger_user_id, phone: targetPhone, confirmedAt: timestamp, method: target.platform === "telegram" ? "telegram_contact" : "test_max_provider" }, env);
  }
  function makeRequest(target = { platform: "max", messenger_user_id: "MAX-FICTIONAL-1" }, targetPhone = phone) {
    const proof = targetProof(target, targetPhone);
    const request = service.createAccountLinkRequest({ participantId: registered.participant.id, account: target, phoneVerification: proof });
    return { target, proof, request };
  }
  function ctx(requestId, action, actorId = oldAccount.messenger_user_id, chatType = "private") {
    return { from: { id: Number(actorId) }, chat: { type: chatType }, callbackQuery: { from: { id: Number(actorId) }, data: `link:${action}:${requestId}` } };
  }
  return {
    directory, env, database, service, clock, oldAccount, phone, targetProof, makeRequest, ctx,
    close() {
      try { database.closeDatabase(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
      for (const modulePath of ["../src/database", "../src/participant-service"]) delete require.cache[require.resolve(modulePath)];
    }
  };
}

function workerCall(workerSource, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

test("запрос связывания хранится на сервере, содержит непредсказуемый ID и истекает через десять минут", () => {
  const x = setup();
  try {
    const { request } = x.makeRequest();
    assert.equal(request.status, "pending");
    assert.match(request.request_id, /^[0-9a-f-]{36}$/i);
    assert.equal(Date.parse(request.expires_at) - x.clock, 10 * 60 * 1000);
    const stored = x.database.db.prepare("SELECT state,target_platform,target_account_id FROM account_link_requests WHERE request_id=?").get(request.request_id);
    assert.deepEqual(stored, { state: "pending", target_platform: "max", target_account_id: "MAX-FICTIONAL-1" });
    assert.equal(Object.hasOwn(stored, "phone"), false);
  } finally { x.close(); }
});

test("незавершённый запрос переживает закрытие и повторное открытие SQLite", () => {
  const x = setup();
  try {
    const { request } = x.makeRequest();
    const savedPath = x.database.dbPath;
    x.database.closeDatabase();
    delete require.cache[require.resolve("../src/database")];
    const reopened = require("../src/database");
    assert.equal(reopened.db.prepare("SELECT state FROM account_link_requests WHERE request_id=?").get(request.request_id).state, "pending");
    reopened.closeDatabase();
    assert.ok(fs.existsSync(savedPath));
  } finally { x.close(); }
});

test("ограничения SQLite не позволяют оживить финальное состояние запроса", () => {
  const x = setup();
  try {
    const { request } = x.makeRequest();
    x.service.rejectAccountLinkRequestFromTelegram(x.ctx(request.request_id, "reject"), request.request_id);
    assert.throws(() => x.database.db.prepare("UPDATE account_link_requests SET state='approved' WHERE request_id=?").run(request.request_id), /invalid account link request state transition/);
    assert.equal(x.database.db.prepare("SELECT state FROM account_link_requests WHERE request_id=?").get(request.request_id).state, "rejected");
  } finally { x.close(); }
});

test("только фактически связанный Telegram ID и явный callback из личного чата могут одобрить", () => {
  const x = setup();
  try {
    const { request } = x.makeRequest();
    assert.throws(() => x.service.approveAccountLinkRequestFromTelegram(x.ctx(request.request_id, "approve", "780000099"), request.request_id), { code: "ACCOUNT_LINK_APPROVAL_INVALID" });
    assert.throws(() => x.service.approveAccountLinkRequestFromTelegram(x.ctx(request.request_id, "reject", undefined, "group"), request.request_id), { code: "ACCOUNT_LINK_APPROVAL_INVALID" });
    const forgedCallback = x.ctx(request.request_id, "approve");
    forgedCallback.callbackQuery.data = `link:approve:${request.request_id}-other`;
    assert.throws(() => x.service.approveAccountLinkRequestFromTelegram(forgedCallback, request.request_id), { code: "ACCOUNT_LINK_APPROVAL_INVALID" });
    assert.equal(x.service.approveAccountLinkRequestFromTelegram(x.ctx(request.request_id, "approve"), request.request_id).status, "approved");
  } finally { x.close(); }
});

test("отклонённый или отменённый запрос нельзя одобрить повторно", () => {
  const x = setup();
  try {
    const rejected = x.makeRequest({ platform: "max", messenger_user_id: "MAX-REJECT" }).request;
    assert.equal(x.service.rejectAccountLinkRequestFromTelegram(x.ctx(rejected.request_id, "reject"), rejected.request_id).status, "rejected");
    assert.equal(x.service.approveAccountLinkRequestFromTelegram(x.ctx(rejected.request_id, "approve"), rejected.request_id).status, "rejected");
    const cancelled = x.makeRequest({ platform: "max", messenger_user_id: "MAX-CANCEL" }).request;
    assert.equal(x.service.cancelAccountLinkRequestFromTelegram(x.ctx(cancelled.request_id, "cancel"), cancelled.request_id).status, "cancelled");
    assert.equal(x.service.completeAccountLinkRequest({ requestId: cancelled.request_id, account: { platform: "max", messenger_user_id: "MAX-CANCEL" }, phoneVerification: x.targetProof({ platform: "max", messenger_user_id: "MAX-CANCEL" }) }).status, "cancelled");
  } finally { x.close(); }
});

test("approval alone does not link; fresh target proof is required to consume request", () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    x.service.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id);
    const result = x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: flow.proof });
    assert.equal(result.status, "linked");
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE participant_id=?").get(result.participant_id).n, 2);
    assert.equal(x.database.db.prepare("SELECT state FROM account_link_requests WHERE request_id=?").get(flow.request.request_id).state, "consumed");
  } finally { x.close(); }
});

test("повторное завершение того же запроса идемпотентно и не создаёт второй аккаунт", () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    x.service.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id);
    assert.equal(x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: flow.proof }).status, "linked");
    assert.equal(x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: flow.proof }).status, "already_consumed");
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 1);
  } finally { x.close(); }
});

test("нельзя подменить идентификатор аккаунта, номер, участника или подтверждение", () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    x.service.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id);
    assert.throws(() => x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: { ...flow.target, messenger_user_id: "MAX-SPOOF" }, phoneVerification: flow.proof }), { code: "PHONE_PROOF_INVALID" });
    const forged = { ...flow.proof, phone: "+79007779999" };
    assert.throws(() => x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: forged }), { code: "PHONE_PROOF_INVALID" });
    assert.equal(x.database.db.prepare("SELECT state FROM account_link_requests WHERE request_id=?").get(flow.request.request_id).state, "approved");
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("запрос истекает, а его повторное использование не восстанавливает доступ", () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    const expiry = new Date(x.clock + 10 * 60 * 1000).toISOString();
    x.database.db.prepare("UPDATE account_link_requests SET expires_at=? WHERE request_id=?").run(expiry, flow.request.request_id);
    const laterService = require("../src/participant-service").createRegistrationService({ database: x.database, envProvider: () => x.env, now: () => x.clock + 10 * 60 * 1000 + 1, allowedPhoneMethods: { telegram: ["telegram_contact"], max: ["test_max_provider"] } });
    assert.equal(laterService.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id).status, "expired");
    assert.equal(laterService.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id).status, "expired");
  } finally { x.close(); }
});

test("отзыв согласия и изменение анкеты после approval блокируют связывание", () => {
  for (const change of ["consent", "profile"]) {
    const x = setup();
    try {
      const flow = x.makeRequest({ platform: "max", messenger_user_id: `MAX-STALE-${change}` });
      x.service.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id);
      if (change === "consent") x.database.db.prepare("UPDATE participants SET personal_data_consent=0,consent_withdrawn_at=? WHERE id=?").run(new Date(x.clock).toISOString(), 1);
      else x.database.updateParticipant(1, { city: "Вымышленный город" });
      if (change === "consent") assert.throws(() => x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: flow.proof }), { code: "CONSENT_WITHDRAWN" });
      else assert.equal(x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: flow.proof }).status, "stale");
      assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
    } finally { x.close(); }
  }
});

test("удаление участника удаляет его запросы связывания через FK", () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    x.database.deleteParticipantById(1);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM account_link_requests WHERE request_id=?").get(flow.request.request_id).n, 0);
    assert.equal(x.database.db.pragma("foreign_key_check").length, 0);
  } finally { x.close(); }
});

test("MAX остаётся недоступен в production без реально настроенного provider proof", () => {
  const x = setup();
  try {
    const production = require("../src/participant-service").createRegistrationService({ database: x.database, envProvider: () => x.env, now: () => x.clock });
    const target = { platform: "max", messenger_user_id: "MAX-NO-PROVIDER" };
    const proof = makePhoneVerificationProof({ platform: "max", accountId: target.messenger_user_id, phone: x.phone, confirmedAt: new Date(x.clock).toISOString(), method: "test_max_provider" }, x.env);
    assert.throws(() => production.createAccountLinkRequest({ participantId: 1, account: target, phoneVerification: proof }), { code: "PHONE_PROOF_INVALID" });
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM account_link_requests").get().n, 0);
  } finally { x.close(); }
});

test("деморежим блокирует создание, approval и завершение протокола", () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    x.env.DEMO_MODE = "true";
    assert.throws(() => x.service.createAccountLinkRequest({ participantId: 1, account: flow.target, phoneVerification: flow.proof }), { code: "DEMO_MODE_LINK_DISABLED" });
    assert.throws(() => x.service.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id), { code: "DEMO_MODE_LINK_DISABLED" });
    assert.throws(() => x.service.completeAccountLinkRequest({ requestId: flow.request.request_id, account: flow.target, phoneVerification: flow.proof }), { code: "DEMO_MODE_LINK_DISABLED" });
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("конкурентные создания из двух SQLite-подключений допускают только один активный запрос", async () => {
  const x = setup();
  try {
    const timestamp = new Date(x.clock).toISOString();
    const workerSource = `const {parentPort,workerData}=require('node:worker_threads');process.env.DB_PATH=workerData.dbPath;const db=require(workerData.modulePath);parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(db.createAccountLinkRequest({requestId:workerData.requestId,participantId:1,targetPlatform:'max',targetAccountId:'MAX-CONCURRENT',verifiedPhone:workerData.phone,proofMethod:'test_max_provider',verifiedAt:workerData.now,expiresAt:workerData.expiry,now:workerData.now}))}catch(e){parentPort.postMessage({error:e.code||e.name})}finally{db.closeDatabase()}})`;
    const data = { dbPath: x.database.dbPath, modulePath: path.resolve(__dirname, "../src/database/index.js"), phone: x.phone, now: timestamp, expiry: new Date(x.clock + 600000).toISOString() };
    const launch = (requestId) => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData: { ...data, requestId } });
      let ready = false;
      worker.on("message", (message) => { if (message === "ready") { ready = true; worker.postMessage("go"); } else resolve(message); });
      worker.on("error", reject);
      worker.on("exit", (code) => { if (code !== 0) reject(new Error("concurrent request worker failed")); });
    });
    const results = await Promise.all([launch("request-concurrent-a"), launch("request-concurrent-b")]);
    assert.equal(results.filter((item) => item.status === "pending").length, 1);
    assert.equal(results.filter((item) => item.error === "ACCOUNT_LINK_REQUEST_EXISTS").length, 1);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM account_link_requests WHERE state IN ('pending','approved')").get().n, 1);
  } finally { x.close(); }
});

test("конкурентное завершение из двух соединений не связывает дважды и даёт только один результат linked", async () => {
  const x = setup();
  try {
    const flow = x.makeRequest();
    x.service.approveAccountLinkRequestFromTelegram(x.ctx(flow.request.request_id, "approve"), flow.request.request_id);
    const workerSource = `const {parentPort,workerData}=require('node:worker_threads');Object.assign(process.env,workerData.env);const {createRegistrationService}=require(workerData.servicePath);const db=require(workerData.dbPathModule);parentPort.postMessage('ready');parentPort.once('message',()=>{try{const s=createRegistrationService({database:db,envProvider:()=>workerData.env,now:()=>workerData.clock,allowedPhoneMethods:workerData.methods});const result=s.completeAccountLinkRequest({requestId:workerData.requestId,account:workerData.account,phoneVerification:workerData.proof});parentPort.postMessage({status:result.status})}catch(e){parentPort.postMessage({error:e.code||e.name})}finally{db.closeDatabase()}})`;
    const workerData = {
      env: x.env, clock: x.clock, methods: { telegram: ["telegram_contact"], max: ["test_max_provider"] },
      servicePath: require.resolve("../src/participant-service"), dbPathModule: require.resolve("../src/database"),
      dbPath: x.database.dbPath, requestId: flow.request.request_id, account: flow.target, proof: flow.proof
    };
    const launch = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData });
      worker.on("message", message => message === "ready" ? worker.postMessage("go") : resolve(message));
      worker.on("error", reject);
      worker.on("exit", code => { if (code !== 0) reject(new Error("completion worker failed")); });
    });
    const results = await Promise.all([launch(), launch()]);
    assert.equal(results.filter(item => item.status === "linked").length, 1);
    assert.equal(results.filter(item => item.status === "already_consumed").length, 1);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 1);
  } finally { x.close(); }
});

