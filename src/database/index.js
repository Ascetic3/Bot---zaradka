const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { getDatabasePath } = require("./config");
const { normalizeDatabasePath } = require("./config");
const { initializeEmptyDatabase, CURRENT_SCHEMA_VERSION } = require("./migrations");
const { createProfileEditSnapshot } = require("../profile-edit-snapshot");

const dbPath = getDatabasePath();
const requireExistingDatabase = process.env.MAGIC_MORNING_REQUIRE_EXISTING_DB === "true";
if (!requireExistingDatabase) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { timeout: 5000, fileMustExist: requireExistingDatabase });
// Normalize only for comparisons: Russian ё and е are equivalent in participant search.
// Latin e remains unchanged because the replacement applies only to Cyrillic ё.
const normalizeSearchText = (value) => String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
db.function("unicode_lower", { deterministic: true }, normalizeSearchText);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// New, empty databases receive the current schema. Existing old schemas are
// deliberately not upgraded during import; an explicit migration command is
// required so a real database can be inspected and authorized separately.
initializeEmptyDatabase(db);

function normalizePhone(phone) {
  const normalized = String(phone).replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("Телефон должен быть в международном формате, например +79001234567");
  return normalized;
}
// Внутренний низкоуровневый помощник для доверенного кода и фикстур. Он сам не проверяет
// подпись подтверждения телефона или согласия; Telegram-обработчики не должны вызывать его напрямую.
function addParticipant(data, account = null) {
  const insert = db.prepare(`INSERT INTO participants(first_name,last_name,phone,city,email,preferred_contact,referral_source,phone_confirmed_at,personal_data_consent,consent_at,consent_version)
    VALUES(@first_name,@last_name,@phone,@city,@email,@preferred_contact,@referral_source,@phone_confirmed_at,@personal_data_consent,@consent_at,@consent_version)`);
  const transaction = db.transaction(() => {
    const result = insert.run({ first_name: data.first_name, last_name: data.last_name ?? null, phone: normalizePhone(data.phone), city: data.city ?? null, email: data.email ?? null, preferred_contact: data.preferred_contact ?? null, referral_source: data.referral_source ?? null, phone_confirmed_at: data.phone_confirmed_at ?? null, personal_data_consent: data.personal_data_consent ? 1 : 0, consent_at: data.consent_at ?? null, consent_version: data.consent_version ?? null });
    if (account) linkAccount(result.lastInsertRowid, account.platform, account.messenger_user_id);
    return getParticipant(result.lastInsertRowid);
  });
  return transaction();
}
function findParticipantByPhone(phone) { return db.prepare("SELECT * FROM participants WHERE phone=?").get(normalizePhone(phone)); }
function findParticipantByTelegramId(id) { return db.prepare("SELECT p.* FROM participants p JOIN accounts a ON a.participant_id=p.id WHERE a.platform='telegram' AND a.messenger_user_id=? AND p.consent_withdrawn_at IS NULL").get(String(id)); }
function findParticipantByTelegramIdIncludingWithdrawn(id) { return db.prepare("SELECT p.* FROM participants p JOIN accounts a ON a.participant_id=p.id WHERE a.platform='telegram' AND a.messenger_user_id=?").get(String(id)); }
function isDemoTestParticipant(participantId) { return Boolean(db.prepare("SELECT 1 FROM demo_test_participants WHERE participant_id=?").get(Number(participantId))); }
function isDemoTestParticipantForTelegram(telegramId) {
  return Boolean(db.prepare(`SELECT 1 FROM demo_test_participants t JOIN accounts a ON a.participant_id=t.participant_id
    WHERE a.platform='telegram' AND a.messenger_user_id=?`).get(String(telegramId)));
}
function requireDemoTestWrite(actorTelegramId, projectRoot) {
  if (String(process.env.DEMO_MODE).toLowerCase() !== "true") throw Object.assign(new Error("Тестовые анкеты доступны только в DEMO_MODE."), { code: "DEMO_MODE_REQUIRED" });
  const expectedPath = path.join(projectRoot, "data", "demo.sqlite");
  if (normalizeDatabasePath(dbPath) !== normalizeDatabasePath(expectedPath)) throw Object.assign(new Error("Запись тестовых анкет остановлена: подключение не указывает на demo.sqlite."), { code: "DEMO_DATABASE_MISMATCH" });
  const role = getAdminRole(actorTelegramId);
  if (!new Set(["owner", "admin"]).has(role)) throw Object.assign(new Error("Тестовая регистрация доступна только действующему администратору."), { code: "DEMO_ADMIN_REQUIRED" });
}
function createDemoTestParticipant(data, telegramId, { projectRoot = path.resolve(__dirname, "../..") } = {}) {
  requireDemoTestWrite(telegramId, projectRoot);
  const phone = normalizePhone(data.phone);
  if (!/^\+7000000\d{4}$/.test(phone)) throw Object.assign(new Error("Разрешён только вымышленный тестовый номер формата +7000000XXXX."), { code: "DEMO_TEST_PHONE_INVALID" });
  const actor = String(telegramId);
  return db.transaction(() => {
    requireDemoTestWrite(actor, projectRoot);
    if (findParticipantByTelegramIdIncludingWithdrawn(actor)) return { status: "account_already_registered" };
    if (findParticipantByPhone(phone)) return { status: "phone_already_registered" };
    const saved = addParticipant({ ...data, phone, phone_confirmed_at: new Date().toISOString(), personal_data_consent: true,
      consent_at: new Date().toISOString(), consent_version: "DEMO_TEST_ONLY_V1" }, { platform: "telegram", messenger_user_id: actor });
    db.prepare("INSERT INTO demo_test_participants(participant_id,created_at) VALUES(?,?)").run(saved.id, new Date().toISOString());
    return { status: "created", participant: saved };
  }).immediate();
}
function listLinkedPlatformsForTelegram(telegramId) {
  return db.prepare(`SELECT a.platform FROM accounts a JOIN participants p ON p.id=a.participant_id
    WHERE a.participant_id=(SELECT participant_id FROM accounts WHERE platform='telegram' AND messenger_user_id=? LIMIT 1)
      AND p.consent_withdrawn_at IS NULL ORDER BY CASE a.platform WHEN 'telegram' THEN 0 ELSE 1 END, a.platform`)
    .all(String(telegramId)).map((row) => row.platform);
}
function listAccountLinkRequestsForTelegram(telegramId, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 20));
  return db.prepare(`SELECT r.request_id, r.target_platform, r.state, r.created_at, r.expires_at
    FROM account_link_requests r
    JOIN participants p ON p.id=r.participant_id
    JOIN accounts owner ON owner.participant_id=p.id AND owner.platform='telegram' AND owner.messenger_user_id=?
    WHERE p.consent_withdrawn_at IS NULL
    ORDER BY r.created_at DESC, r.request_id DESC LIMIT ?`).all(String(telegramId), safeLimit);
}
function getAccountLinkRequestForTelegram(requestId, telegramId) {
  return db.prepare(`SELECT r.request_id, r.participant_id, r.target_platform, r.state, r.created_at, r.expires_at
    FROM account_link_requests r
    JOIN participants p ON p.id=r.participant_id
    JOIN accounts owner ON owner.participant_id=p.id AND owner.platform='telegram' AND owner.messenger_user_id=?
    WHERE r.request_id=? AND p.consent_withdrawn_at IS NULL`).get(String(telegramId), String(requestId));
}
function getParticipant(id) { return db.prepare("SELECT * FROM participants WHERE id=? AND consent_withdrawn_at IS NULL").get(id); }
function getParticipantIncludingWithdrawn(id) { return db.prepare("SELECT * FROM participants WHERE id=?").get(id); }
function searchParticipants(query, limit = 50, offset = 0) {
  const term = String(query ?? "").trim();
  if (!term) return [];
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const phoneDigits = term.replace(/\D/g, "");
  const isPhone = phoneDigits.length >= 7 && phoneDigits.length <= 15 && /^[+\d\s().-]+$/.test(term);
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  if (isPhone) return db.prepare(`SELECT * FROM participants WHERE consent_withdrawn_at IS NULL AND replace(phone,'+','')=? ORDER BY registered_at DESC,id DESC LIMIT ? OFFSET ?`).all(phoneDigits, safeLimit, safeOffset);
  const pattern = `%${normalizeSearchText(escaped)}%`;
  return db.prepare(`SELECT * FROM participants WHERE consent_withdrawn_at IS NULL AND (unicode_lower(first_name) LIKE ? ESCAPE '\\' OR unicode_lower(COALESCE(last_name,'')) LIKE ? ESCAPE '\\' OR unicode_lower(first_name || ' ' || COALESCE(last_name,'')) LIKE ? ESCAPE '\\') ORDER BY registered_at DESC,id DESC LIMIT ? OFFSET ?`).all(pattern, pattern, pattern, safeLimit, safeOffset);
}
function listParticipants(limit = 10, offset = 0) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 100));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  return db.prepare("SELECT id, first_name, last_name, city, registered_at FROM participants WHERE consent_withdrawn_at IS NULL ORDER BY registered_at DESC,id DESC LIMIT ? OFFSET ?").all(safeLimit, safeOffset);
}
function updateParticipantIfUnchanged(id, telegramId, expected, changes, validateCandidate) {
  const allowed = new Set(["first_name", "last_name", "city", "email", "preferred_contact", "referral_source"]);
  const entries = Object.entries(changes || {}).filter(([key]) => allowed.has(key));
  if (entries.length !== 1 || typeof validateCandidate !== "function") throw new Error("Некорректное изменение анкеты.");
  return db.transaction(() => {
    const current = db.prepare(`SELECT p.* FROM participants p
      JOIN accounts a ON a.participant_id=p.id AND a.platform='telegram'
      WHERE p.id=? AND a.messenger_user_id=?`).get(Number(id), String(telegramId));
    if (!current) return { status: "not_found" };
    if (current.personal_data_consent !== 1 || !current.consent_at || !current.consent_version || current.consent_withdrawn_at) return { status: "consent_withdrawn" };
    const snapshotFields = ["id", "first_name", "last_name", "phone", "city", "email", "preferred_contact", "referral_source", "registered_at", "updated_at", "phone_confirmed_at", "personal_data_consent", "consent_at", "consent_version", "consent_withdrawn_at"];
    if (!expected || snapshotFields.some((field) => (expected[field] ?? null) !== (current[field] ?? null))) return { status: "conflict", participant: current };
    const [field, rawValue] = entries[0];
    const validated = validateCandidate(current, field, rawValue);
    if (!validated || !Object.hasOwn(validated, field)) throw new Error("Проверка изменения не вернула значение поля.");
    const update = db.prepare(`UPDATE participants SET ${field}=@value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=@id AND personal_data_consent=1 AND consent_at IS NOT NULL AND trim(consent_at)<>'' AND consent_version IS NOT NULL AND trim(consent_version)<>'' AND consent_withdrawn_at IS NULL AND EXISTS (
        SELECT 1 FROM accounts WHERE participant_id=@id AND platform='telegram' AND messenger_user_id=@telegramId
      )`).run({ value: validated[field], id: Number(id), telegramId: String(telegramId) });
    if (update.changes !== 1) return { status: "not_found" };
    return { status: "updated", participant: getParticipant(id) };
  }).immediate();
}
function updateParticipant(id, fields) {
  const allowed = new Set(["first_name","last_name","phone","city","email","preferred_contact","referral_source","phone_confirmed_at","personal_data_consent"]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return getParticipant(id);
  const assignments = entries.map(([key]) => `${key}=@${key}`).join(", ");
  const values = Object.fromEntries(entries);
  if (values.phone !== undefined) values.phone = normalizePhone(values.phone);
  if (values.personal_data_consent !== undefined) values.personal_data_consent = values.personal_data_consent ? 1 : 0;
  return db.transaction(() => {
    const current = db.prepare("SELECT * FROM participants WHERE id=? AND consent_withdrawn_at IS NULL").get(Number(id));
    if (!current) return undefined;
    const candidate = { ...current, ...values };
    if (candidate.preferred_contact === "Электронная почта" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(candidate.email ?? ""))) {
      throw new Error("Для связи по электронной почте необходимо сохранить корректный email.");
    }
    db.prepare(`UPDATE participants SET ${assignments}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id AND consent_withdrawn_at IS NULL`).run({ ...values, id });
    return undefined;
  }).immediate();
}
// Internal verified-contact contract for a future phone-change flow. The caller
// must pass a contact object received from Telegram; plain text is never enough.
function updatePhoneFromVerifiedTelegramContact(telegramId, contact, confirmedAt = new Date().toISOString()) {
  const actor = String(telegramId ?? "");
  if (!/^\d+$/.test(actor) || !contact || String(contact.user_id ?? "") !== actor) {
    throw new Error("Номер телефона можно изменить только после подтверждения собственного контакта Telegram.");
  }
  const phone = normalizePhone(contact.phone_number);
  const when = new Date(confirmedAt);
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now()) throw new Error("Дата подтверждения телефона некорректна.");
  return db.transaction(() => {
    const participant = db.prepare("SELECT p.id FROM participants p JOIN accounts a ON a.participant_id=p.id WHERE a.platform='telegram' AND a.messenger_user_id=? AND p.consent_withdrawn_at IS NULL").get(actor);
    if (!participant) throw new Error("Анкета для этого Telegram-аккаунта не найдена.");
    db.prepare("UPDATE participants SET phone=?, phone_confirmed_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(phone, when.toISOString(), participant.id);
    return getParticipant(participant.id);
  }).immediate();
}
class AccountLinkConflictError extends Error {
  constructor(message, code = "ACCOUNT_LINK_CONFLICT") {
    super(message);
    this.name = "AccountLinkConflictError";
    this.code = code;
  }
}

function accountLinkInput(participantId, platform, messengerUserId) {
  if (!["telegram", "max"].includes(platform)) throw new Error("Неизвестная платформа");
  const participant = Number(participantId);
  if (!Number.isSafeInteger(participant) || participant <= 0) throw new Error("Некорректный участник для привязки аккаунта.");
  const target = String(messengerUserId ?? "").trim();
  if (!target) throw new Error("Не указан идентификатор аккаунта.");
  return { participant, platform, target };
}

function linkAccountInTransaction(participant, platform, target) {
  if (!db.prepare("SELECT 1 FROM participants WHERE id=? AND consent_withdrawn_at IS NULL").get(participant)) {
    throw new Error("Анкета недоступна для привязки аккаунта.");
  }
  const byMessenger = db.prepare("SELECT * FROM accounts WHERE platform=? AND messenger_user_id=?").get(platform, target);
  if (byMessenger) {
    if (Number(byMessenger.participant_id) !== participant) throw new AccountLinkConflictError("Этот аккаунт уже привязан к другому участнику.");
    return byMessenger;
  }
  const byParticipant = db.prepare("SELECT * FROM accounts WHERE participant_id=? AND platform=?").get(participant, platform);
  if (byParticipant) throw new AccountLinkConflictError("У участника уже привязан другой аккаунт этой платформы.");
  db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,?,?)").run(participant, platform, target);
  const linked = db.prepare("SELECT * FROM accounts WHERE platform=? AND messenger_user_id=?").get(platform, target);
  if (!linked || Number(linked.participant_id) !== participant) throw new AccountLinkConflictError("Не удалось подтвердить привязку аккаунта к этому участнику.");
  return linked;
}

// Низкоуровневая запись связи. В пользовательском Telegram-потоке используйте
// registrationService, который проверяет доказательство телефона и явное решение владельца анкеты.
function linkAccount(participantId, platform, messengerUserId) {
  const { participant, target } = accountLinkInput(participantId, platform, messengerUserId);
  // Lock before checking both UNIQUE keys, so independent bot processes cannot
  // insert a competing link between the check and the write.
  return db.transaction(() => linkAccountInTransaction(participant, platform, target)).immediate();
}

// Низкоуровневая атомарная запись. Проверку подписей, согласия, телефона и режима
// выполняет registrationService перед вызовом этого метода; не вызывайте из обработчиков напрямую.
function registerParticipant(data, account) {
  const platform = String(account?.platform ?? "").trim().toLowerCase();
  const target = String(account?.messenger_user_id ?? "").trim();
  if (!["telegram", "max"].includes(platform) || !target) throw new Error("Для регистрации нужен идентификатор аккаунта мессенджера.");
  const phone = normalizePhone(data.phone);
  return db.transaction(() => {
    const linked = db.prepare(`SELECT a.participant_id, p.phone, p.consent_withdrawn_at, p.personal_data_consent, p.consent_at, p.consent_version
      FROM accounts a JOIN participants p ON p.id=a.participant_id
      WHERE a.platform=? AND a.messenger_user_id=?`).get(platform, target);
    if (linked) {
      if (linked.consent_withdrawn_at || linked.personal_data_consent !== 1 || !linked.consent_at || !linked.consent_version) {
        throw new AccountLinkConflictError("Регистрация по этому аккаунту недоступна.", "CONSENT_WITHDRAWN");
      }
      if (linked.phone !== phone) throw new AccountLinkConflictError("У аккаунта уже есть анкета с другим номером.");
      return { status: "already_registered", participant: getParticipant(linked.participant_id) };
    }
    const existingPhone = db.prepare("SELECT id, consent_withdrawn_at FROM participants WHERE phone=?").get(phone);
    if (existingPhone) {
      const code = existingPhone.consent_withdrawn_at ? "CONSENT_WITHDRAWN" : "PHONE_ALREADY_REGISTERED";
      throw new AccountLinkConflictError("Номер уже связан с существующей анкетой; требуется безопасная проверка связи аккаунтов.", code);
    }

    const insert = db.prepare(`INSERT INTO participants(first_name,last_name,phone,city,email,preferred_contact,referral_source,phone_confirmed_at,personal_data_consent,consent_at,consent_version)
      VALUES(@first_name,@last_name,@phone,@city,@email,@preferred_contact,@referral_source,@phone_confirmed_at,@personal_data_consent,@consent_at,@consent_version)`);
    const result = insert.run({ first_name: data.first_name, last_name: data.last_name ?? null, phone, city: data.city ?? null, email: data.email ?? null, preferred_contact: data.preferred_contact ?? null, referral_source: data.referral_source ?? null, phone_confirmed_at: data.phone_confirmed_at, personal_data_consent: 1, consent_at: data.consent_at, consent_version: data.consent_version });
    const newId = Number(result.lastInsertRowid);
    linkAccountInTransaction(newId, platform, target);
    return { status: "created", participant: getParticipant(newId) };
  }).immediate();
}

function createAccountLinkRequest({ requestId, participantId, targetPlatform, targetAccountId, verifiedPhone, proofMethod, verifiedAt, expiresAt, now = new Date().toISOString() }) {
  const { participant, target } = accountLinkInput(participantId, targetPlatform, targetAccountId);
  const phone = normalizePhone(verifiedPhone);
  const id = String(requestId ?? "").trim();
  const method = String(proofMethod ?? "").trim();
  const verifiedDate = new Date(verifiedAt);
  const expiryDate = new Date(expiresAt);
  const nowDate = new Date(now);
  if (!id || id.length > 80 || !method || [verifiedDate, expiryDate, nowDate].some((date) => Number.isNaN(date.getTime())) || expiryDate <= nowDate || verifiedDate > nowDate) throw new Error("Параметры запроса связывания некорректны.");
  try {
    return db.transaction(() => {
      const owner = db.prepare("SELECT phone,updated_at FROM participants WHERE id=? AND consent_withdrawn_at IS NULL AND personal_data_consent=1 AND consent_at IS NOT NULL AND trim(consent_version)<>''").get(participant);
      if (!owner) throw new AccountLinkConflictError("Анкета недоступна для связывания.", "CONSENT_WITHDRAWN");
      if (owner.phone !== phone) throw new AccountLinkConflictError("Подтверждённый номер не совпадает с анкетой.", "ACCOUNT_LINK_PHONE_MISMATCH");
      db.prepare("UPDATE account_link_requests SET state='expired' WHERE state IN ('pending','approved') AND expires_at<=?").run(nowDate.toISOString());
      db.prepare("UPDATE account_link_requests SET state='cancelled' WHERE participant_id=? AND state IN ('pending','approved') AND participant_updated_at<>?").run(participant, owner.updated_at);
      const linkedTarget = db.prepare("SELECT participant_id FROM accounts WHERE platform=? AND messenger_user_id=?").get(targetPlatform, target);
      if (linkedTarget) {
        if (Number(linkedTarget.participant_id) === participant) return { status: "already_linked", request_id: null };
        throw new AccountLinkConflictError("Этот аккаунт уже связан с другой анкетой.");
      }
      db.prepare(`INSERT INTO account_link_requests(request_id,participant_id,target_platform,target_account_id,target_verified_at,target_proof_method,state,created_at,expires_at,participant_updated_at)
        VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(id, participant, targetPlatform, target, verifiedDate.toISOString(), method, nowDate.toISOString(), expiryDate.toISOString(), owner.updated_at);
      return { status: "pending", request_id: id, expires_at: expiryDate.toISOString() };
    }).immediate();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") throw new AccountLinkConflictError("Для этого аккаунта уже есть активный запрос связывания.", "ACCOUNT_LINK_REQUEST_EXISTS");
    throw error;
  }
}

function transitionAccountLinkRequest({ requestId, telegramActorId, action, now = new Date().toISOString() }) {
  const id = String(requestId ?? "").trim();
  const actor = String(telegramActorId ?? "").trim();
  if (!id || !/^\d+$/.test(actor) || !["approve", "reject", "cancel"].includes(action)) throw new Error("Параметры решения запроса связывания некорректны.");
  const when = new Date(now);
  if (Number.isNaN(when.getTime())) throw new Error("Дата решения запроса некорректна.");
  return db.transaction(() => {
    const request = db.prepare("SELECT * FROM account_link_requests WHERE request_id=?").get(id);
    if (!request) return { status: "not_found" };
    if (request.state !== "pending") return { status: request.state };
    const ownerAccount = db.prepare("SELECT 1 FROM accounts WHERE participant_id=? AND platform='telegram' AND messenger_user_id=?").get(request.participant_id, actor);
    if (!ownerAccount) throw new AccountLinkConflictError("Подтвердить запрос может только уже связанный Telegram-аккаунт участника.", "ACCOUNT_LINK_APPROVAL_INVALID");
    if (Date.parse(request.expires_at) <= when.getTime()) {
      db.prepare("UPDATE account_link_requests SET state='expired',decision_by_platform='telegram',decision_by_account_id=?,decision_at=? WHERE request_id=? AND state='pending'").run(actor, when.toISOString(), id);
      return { status: "expired" };
    }
    if (action === "approve") {
      const participant = db.prepare("SELECT updated_at,personal_data_consent,consent_at,consent_version,consent_withdrawn_at FROM participants WHERE id=?").get(request.participant_id);
      if (!participant || participant.consent_withdrawn_at || participant.personal_data_consent !== 1 || !participant.consent_at || !participant.consent_version) {
        db.prepare("UPDATE account_link_requests SET state='cancelled',decision_by_platform='telegram',decision_by_account_id=?,decision_at=? WHERE request_id=? AND state='pending'").run(actor, when.toISOString(), id);
        return { status: "cancelled" };
      }
      if (participant.updated_at !== request.participant_updated_at) {
        db.prepare("UPDATE account_link_requests SET state='cancelled',decision_by_platform='telegram',decision_by_account_id=?,decision_at=? WHERE request_id=? AND state='pending'").run(actor, when.toISOString(), id);
        return { status: "stale" };
      }
    }
    const state = action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled";
    db.prepare("UPDATE account_link_requests SET state=?,decision_by_platform='telegram',decision_by_account_id=?,decision_at=? WHERE request_id=? AND state='pending'").run(state, actor, when.toISOString(), id);
    return { status: state };
  }).immediate();
}

function completeAccountLinkRequest({ requestId, platform, messengerUserId, verifiedPhone, proofMethod, verifiedAt, now = new Date().toISOString() }) {
  const id = String(requestId ?? "").trim();
  const { target } = accountLinkInput(1, platform, messengerUserId);
  const phone = normalizePhone(verifiedPhone);
  const when = new Date(now);
  const verifiedDate = new Date(verifiedAt);
  if (!id || Number.isNaN(when.getTime()) || Number.isNaN(verifiedDate.getTime())) throw new Error("Параметры завершения связывания некорректны.");
  return db.transaction(() => {
    const request = db.prepare("SELECT * FROM account_link_requests WHERE request_id=?").get(id);
    if (!request) return { status: "not_found" };
    if (request.state === "consumed") {
      const linked = db.prepare("SELECT participant_id FROM accounts WHERE platform=? AND messenger_user_id=?").get(platform, target);
      if (linked && Number(linked.participant_id) === Number(request.participant_id)) return { status: "already_consumed" };
      throw new AccountLinkConflictError("Этот запрос уже использован.", "ACCOUNT_LINK_REQUEST_CONSUMED");
    }
    if (request.target_platform !== platform || request.target_account_id !== target || request.target_verified_at !== verifiedDate.toISOString() || request.target_proof_method !== proofMethod || phone !== db.prepare("SELECT phone FROM participants WHERE id=?").get(request.participant_id)?.phone) throw new AccountLinkConflictError("Подтверждение не соответствует этому запросу или номер изменился.", "ACCOUNT_LINK_APPROVAL_STALE");
    if (request.state !== "approved") return { status: request.state };
    if (Date.parse(request.expires_at) <= when.getTime()) {
      db.prepare("UPDATE account_link_requests SET state='expired' WHERE request_id=? AND state='approved'").run(id);
      return { status: "expired" };
    }
    const owner = db.prepare("SELECT phone,updated_at,personal_data_consent,consent_at,consent_version,consent_withdrawn_at FROM participants WHERE id=?").get(request.participant_id);
    if (!owner || owner.consent_withdrawn_at || owner.personal_data_consent !== 1 || !owner.consent_at || !owner.consent_version) throw new AccountLinkConflictError("Анкета недоступна для связывания.", "CONSENT_WITHDRAWN");
    if (owner.updated_at !== request.participant_updated_at || owner.phone !== phone) {
      db.prepare("UPDATE account_link_requests SET state='cancelled' WHERE request_id=? AND state='approved'").run(id);
      return { status: "stale" };
    }
    const approver = db.prepare("SELECT 1 FROM accounts WHERE participant_id=? AND platform='telegram' AND messenger_user_id=?").get(request.participant_id, request.decision_by_account_id);
    if (request.decision_by_platform !== "telegram" || !approver) throw new AccountLinkConflictError("Подтверждавший аккаунт больше не связан с участником.", "ACCOUNT_LINK_APPROVAL_INVALID");
    const linked = linkAccountInTransaction(Number(request.participant_id), platform, target);
    const consumed = db.prepare("UPDATE account_link_requests SET state='consumed',completed_at=? WHERE request_id=? AND state='approved'").run(when.toISOString(), id);
    if (consumed.changes !== 1) throw new AccountLinkConflictError("Запрос связывания уже использован.", "ACCOUNT_LINK_REQUEST_CONSUMED");
    return { status: "linked", participant_id: Number(linked.participant_id) };
  }).immediate();
}
function saveDraft(platform, userId, step, answers) { db.prepare(`INSERT INTO registration_drafts(platform,messenger_user_id,current_step,answers_json,updated_at) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(platform,messenger_user_id) DO UPDATE SET current_step=excluded.current_step,answers_json=excluded.answers_json,updated_at=excluded.updated_at`).run(platform,String(userId),step,JSON.stringify(answers)); }
function getDraft(platform, userId) {
  const row = db.prepare("SELECT * FROM registration_drafts WHERE platform=? AND messenger_user_id=?").get(platform, String(userId));
  if (!row) return undefined;
  try { return { ...row, answers: JSON.parse(row.answers_json) }; }
  catch { return { ...row, answers: null, invalidAnswers: true }; }
}
function beginProfileEditDraft(telegramId, field) {
  const actor = String(telegramId ?? "");
  const allowed = new Set(["first_name", "last_name", "city", "email", "preferred_contact", "referral_source"]);
  if (!/^\d+$/.test(actor) || !allowed.has(field)) return { status: "invalid" };
  return db.transaction(() => {
    const participant = db.prepare(`SELECT p.* FROM participants p
      JOIN accounts a ON a.participant_id=p.id AND a.platform='telegram'
      WHERE a.messenger_user_id=?`).get(actor);
    if (!participant) return { status: "not_found" };
    if (participant.personal_data_consent !== 1 || !participant.consent_at || !participant.consent_version || participant.consent_withdrawn_at) {
      return { status: "consent_withdrawn" };
    }
    const snapshot = createProfileEditSnapshot(participant);
    saveDraft("telegram", actor, `profile_edit:${field}`, {
      edit_field: field,
      participant_id: Number(participant.id),
      snapshot
    });
    return { status: "ready", participant, snapshot };
  }).immediate();
}
function hasDraft(platform, userId) { return Boolean(db.prepare("SELECT 1 FROM registration_drafts WHERE platform=? AND messenger_user_id=?").get(platform,String(userId))); }
function deleteDraft(platform, userId) { return db.prepare("DELETE FROM registration_drafts WHERE platform=? AND messenger_user_id=?").run(platform,String(userId)).changes > 0; }
function getAdminRole(telegramId) { return db.prepare("SELECT role FROM admins WHERE telegram_id=?").get(String(telegramId))?.role ?? null; }
function initializeOwner(telegramId) {
  if (!/^\d+$/.test(String(telegramId || ""))) return false;
  // OWNER_TELEGRAM_ID is only a first-run bootstrap value. It must never
  // promote someone merely because an existing owner was removed manually.
  const result = db.prepare("INSERT INTO admins(telegram_id,role) SELECT ?, 'owner' WHERE NOT EXISTS (SELECT 1 FROM admins)").run(String(telegramId));
  return result.changes > 0 || getAdminRole(telegramId) === "owner";
}
function transferOwner(currentOwnerId, newOwnerId, previousOwnerRole, confirmation) {
  const current = String(currentOwnerId ?? "");
  const next = String(newOwnerId ?? "");
  if (!/^\d+$/.test(current) || !/^\d+$/.test(next)) throw new Error("Для передачи нужны действительные Telegram ID.");
  if (confirmation !== "TRANSFER_OWNER") throw new Error("Передача требует явного подтверждения.");
  if (!new Set(["admin", "remove"]).has(previousOwnerRole)) throw new Error("Нужно явно указать права прежнего владельца после передачи.");
  if (current === next) return false;
  return db.transaction(() => {
    const actor = db.prepare("SELECT role FROM admins WHERE telegram_id=?").get(current);
    const target = db.prepare("SELECT role FROM admins WHERE telegram_id=?").get(next);
    const ownerCount = db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role='owner'").get().count;
    // The recipient must already be an administrator added through the normal
    // owner-only workflow, and ambiguous multi-owner states require recovery.
    if (actor?.role !== "owner" || target?.role !== "admin" || ownerCount !== 1) return false;
    if (previousOwnerRole === "admin") {
      const demoted = db.prepare("UPDATE admins SET role='admin' WHERE telegram_id=? AND role='owner'").run(current);
      if (demoted.changes !== 1) throw new Error("Не удалось изменить роль прежнего владельца.");
    } else {
      const removed = db.prepare("DELETE FROM admins WHERE telegram_id=? AND role='owner'").run(current);
      if (removed.changes !== 1) throw new Error("Не удалось удалить роль прежнего владельца.");
    }
    const promoted = db.prepare("UPDATE admins SET role='owner' WHERE telegram_id=? AND role='admin'").run(next);
    if (promoted.changes !== 1 || db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role='owner'").get().count < 1) {
      throw new Error("Передача не завершена; транзакция отменена.");
    }
    return true;
  }).immediate();
}
function updateAdminUsername(telegramId, username) {
  const normalized = typeof username === "string" && username.trim() ? username.trim().replace(/^@/, "") : null;
  return db.prepare("UPDATE admins SET username=? WHERE telegram_id=? AND username IS NOT ?").run(normalized, String(telegramId), normalized).changes > 0;
}
function listAdmins() { return db.prepare("SELECT telegram_id, role, username, added_at FROM admins ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, telegram_id").all(); }
function addAdmin(telegramId) {
  if (!/^\d+$/.test(String(telegramId || ""))) throw new Error("Telegram ID должен состоять из цифр.");
  if (db.prepare("SELECT 1 FROM admins WHERE telegram_id=?").get(String(telegramId))) return false;
  db.prepare("INSERT INTO admins(telegram_id,role) VALUES(?,'admin')").run(String(telegramId));
  return true;
}
function removeAdmin(telegramId) {
  const row = db.prepare("SELECT role FROM admins WHERE telegram_id=?").get(String(telegramId));
  if (!row || row.role === "owner") return false;
  return db.prepare("DELETE FROM admins WHERE telegram_id=? AND role='admin'").run(String(telegramId)).changes > 0;
}
function getParticipantCount() { return db.prepare("SELECT COUNT(*) AS count FROM participants WHERE consent_withdrawn_at IS NULL").get().count; }
function getParticipantStatistics() {
  const totals = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN registered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') THEN 1 ELSE 0 END) AS last_7_days,
    SUM(CASE WHEN registered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') THEN 1 ELSE 0 END) AS last_30_days
    FROM participants WHERE consent_withdrawn_at IS NULL`).get();
  const groupQuery = (column) => db.prepare(`WITH grouped AS (
      SELECT COALESCE(NULLIF(trim(${column}), ''), 'Не указано') AS category, COUNT(*) AS count
      FROM participants WHERE consent_withdrawn_at IS NULL GROUP BY category
    ), ranked AS (
      SELECT category, count, SUM(count) OVER () AS total_count,
        ROW_NUMBER() OVER (ORDER BY count DESC, category COLLATE NOCASE ASC) AS position
      FROM grouped
    )
    SELECT category, count, total_count FROM ranked WHERE position <= 10 ORDER BY count DESC, category COLLATE NOCASE ASC`).all();
  const categories = (rows) => {
    const result = rows.map(({ category, count }) => ({ category, count }));
    const grandTotal = rows.length ? Number(rows[0].total_count) : 0;
    const other = grandTotal - result.reduce((sum, item) => sum + Number(item.count), 0);
    if (other > 0) result.push({ category: "Другие", count: other });
    if (!result.length) result.push({ category: "Не указано", count: 0 });
    return result;
  };
  return {
    total: Number(totals.total),
    last_7_days: Number(totals.last_7_days || 0),
    last_30_days: Number(totals.last_30_days || 0),
    cities: categories(groupQuery("city")),
    referral_sources: categories(groupQuery("referral_source")),
    preferred_contacts: categories(groupQuery("preferred_contact"))
  };
}
function getParticipantsForExport() {
  return db.prepare(`SELECT p.id, p.first_name, p.last_name, p.phone, p.city, p.email,
      p.preferred_contact, p.referral_source, p.registered_at, p.phone_confirmed_at, p.consent_at,
      CASE WHEN demo_test.participant_id IS NULL THEN 0 ELSE 1 END AS demo_test,
      telegram.messenger_user_id AS telegram_id, max_account.messenger_user_id AS max_id
    FROM participants AS p
    LEFT JOIN demo_test_participants demo_test ON demo_test.participant_id=p.id
    LEFT JOIN accounts AS telegram ON telegram.participant_id=p.id AND telegram.platform='telegram'
    LEFT JOIN accounts AS max_account ON max_account.participant_id=p.id AND max_account.platform='max'
    WHERE p.consent_withdrawn_at IS NULL ORDER BY p.id ASC`).all();
}
function getParticipantDeletionPreview(participantId) {
  const id = Number(participantId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Нужен действительный внутренний ID участника.");
  if (!db.prepare("SELECT 1 FROM participants WHERE id=?").get(id)) return null;
  const platforms = db.prepare("SELECT platform FROM accounts WHERE participant_id=? ORDER BY platform").all(id).map(({ platform }) => platform);
  const registrationDrafts = db.prepare(`SELECT COUNT(*) AS count FROM registration_drafts d
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.participant_id=? AND a.platform=d.platform AND a.messenger_user_id=d.messenger_user_id)`).get(id).count;
  const withdrawalRequests = db.prepare("SELECT COUNT(*) AS count FROM consent_withdrawal_requests WHERE participant_id=?").get(id).count;
  return {
    participant_id: id,
    participant_records: 1,
    linked_accounts: platforms,
    registration_drafts: Number(registrationDrafts),
    consent_withdrawal_requests: Number(withdrawalRequests)
  };
}
// Internal operation only. Account authorization and explicit confirmation are
// enforced by participant-data.js before this database-level transaction runs.
function deleteParticipantById(participantId) {
  if (String(process.env.DEMO_MODE).toLowerCase() === "true") {
    const error = new Error("Удаление участников отключено в демонстрационном режиме.");
    error.code = "DEMO_MODE_DELETE_DISABLED";
    throw error;
  }
  return deleteParticipantTransaction(participantId);
}
function deleteDemoTestParticipantById(participantId, actorTelegramId, { projectRoot = path.resolve(__dirname, "../..") } = {}) {
  requireDemoTestWrite(actorTelegramId, projectRoot);
  const id = Number(participantId);
  return db.transaction(() => {
    requireDemoTestWrite(actorTelegramId, projectRoot);
    if (!isDemoTestParticipant(id)) throw Object.assign(new Error("Удалять разрешено только специально помеченные тестовые анкеты."), { code: "DEMO_TEST_PARTICIPANT_REQUIRED" });
    return deleteParticipantTransaction(id);
  }).immediate();
}
function deleteParticipantTransaction(participantId) {
  const id = Number(participantId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Нужен действительный внутренний ID участника.");
  return db.transaction(() => {
    const preview = getParticipantDeletionPreview(id);
    if (!preview) return { deleted: false, participant_id: id, accounts_deleted: 0, registration_drafts_deleted: 0, withdrawal_requests_deleted: 0 };
    const linkedAccounts = db.prepare("SELECT platform,messenger_user_id FROM accounts WHERE participant_id=?").all(id);
    // Keep delivery outcomes for aggregate reporting, but remove the messenger
    // identifier before the account is cascaded away. A tombstone based on the
    // delivery row keeps the broadcast's unique recipient index valid.
    const hasDeliveryHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_deliveries'").get());
    const anonymizedDeliveries = hasDeliveryHistory ? db.prepare(`UPDATE meeting_deliveries
      SET messenger_user_id='deleted-delivery-' || id
      WHERE participant_id=? OR (participant_id IS NULL AND EXISTS (
        SELECT 1 FROM accounts a WHERE a.participant_id=?
          AND a.platform=meeting_deliveries.platform
          AND a.messenger_user_id=meeting_deliveries.messenger_user_id
      ))`).run(id, id).changes : 0;
    const draftsDeleted = db.prepare(`DELETE FROM registration_drafts
      WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.participant_id=? AND a.platform=registration_drafts.platform AND a.messenger_user_id=registration_drafts.messenger_user_id)`).run(id).changes;
    // Keep the minimal request record, but close the pending item in the same
    // transaction as the participant deletion. ON DELETE SET NULL removes the
    // link to the participant after the request has been marked processed.
    const deletionRequestsProcessed = db.prepare(`UPDATE participant_deletion_requests
      SET status='processed' WHERE participant_id=? AND status='pending_review'`).run(id).changes;
    const participantDeleted = db.prepare("DELETE FROM participants WHERE id=?").run(id).changes;
    if (participantDeleted !== 1) throw new Error("Анкета изменилась во время удаления; транзакция отменена.");
    // Remove the chat confirmation only after no active participant account
    // uses that Telegram ID.
    const hasPrivateChatHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_private_chats'").get());
    for (const account of linkedAccounts) {
      if (account.platform !== "telegram") continue;
      if (hasPrivateChatHistory) {
        db.prepare(`DELETE FROM telegram_private_chats WHERE telegram_id=?
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE platform='telegram' AND messenger_user_id=?)`)
          .run(account.messenger_user_id, account.messenger_user_id);
      }
    }
    return {
      deleted: true,
      participant_id: id,
      accounts_deleted: preview.linked_accounts.length,
      delivery_identifiers_anonymized: anonymizedDeliveries,
      registration_drafts_deleted: draftsDeleted,
      deletion_requests_processed: deletionRequestsProcessed,
      withdrawal_requests_deleted: preview.consent_withdrawal_requests
    };
  }).immediate();
}
function getParticipantConsentState(participantId) {
  const id = Number(participantId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.prepare("SELECT id AS participant_id, personal_data_consent, consent_at, consent_version, consent_withdrawn_at FROM participants WHERE id=?").get(id);
  if (!row) return null;
  const active = row.personal_data_consent === 1 && Boolean(row.consent_at && row.consent_version) && !row.consent_withdrawn_at;
  return { ...row, active, processing_based_on_consent_allowed: active };
}
function recordConsentWithdrawalRequest(participantId, requestedAt = new Date().toISOString(), expectedConsentAt = null) {
  const id = Number(participantId);
  const when = new Date(requestedAt);
  if (!Number.isSafeInteger(id) || id <= 0 || Number.isNaN(when.getTime()) || when.getTime() > Date.now()) throw new Error("Параметры запроса отзыва согласия некорректны.");
  return db.transaction(() => {
    const participant = db.prepare("SELECT id, personal_data_consent, consent_at, consent_withdrawn_at FROM participants WHERE id=?").get(id);
    if (!participant) return { status: "not_found", request_id: null };
    if (expectedConsentAt && participant.consent_at !== expectedConsentAt) return { status: "stale_confirmation", request_id: null };
    if (!participant.consent_at || participant.personal_data_consent !== 1) {
      const previous = participant.consent_at && db.prepare("SELECT id, status, requested_at FROM consent_withdrawal_requests WHERE participant_id=? AND consent_at=?").get(id, participant.consent_at);
      return previous
        ? { status: "already_requested", request_id: previous.id, request_status: previous.status, requested_at: previous.requested_at }
        : { status: "no_active_consent", request_id: null };
    }
    const existing = db.prepare("SELECT id, status, requested_at FROM consent_withdrawal_requests WHERE participant_id=? AND consent_at=?").get(id, participant.consent_at);
    if (existing) return { status: "already_requested", request_id: existing.id, request_status: existing.status, requested_at: existing.requested_at };
    const requested = when.toISOString();
    const result = db.prepare("INSERT INTO consent_withdrawal_requests(participant_id,consent_at,requested_at,status) VALUES(?,?,?,'pending_review')")
      .run(id, participant.consent_at, requested);
    const update = db.prepare("UPDATE participants SET personal_data_consent=0, consent_withdrawn_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND personal_data_consent=1 AND consent_at=?")
      .run(requested, id, participant.consent_at);
    if (update.changes !== 1) throw new Error("Согласие изменилось во время обработки запроса; транзакция отменена.");
    return { status: "received", request_id: Number(result.lastInsertRowid), request_status: "pending_review", requested_at: requested };
  }).immediate();
}
function getConsentWithdrawalRequest(requestId) {
  const id = Number(requestId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare("SELECT id, participant_id, consent_at, requested_at, status, resolved_at FROM consent_withdrawal_requests WHERE id=?").get(id) ?? null;
}
function resolveConsentWithdrawalRequest(requestId, resolution, resolvedAt = new Date().toISOString()) {
  if (!["processed", "not_applicable"].includes(resolution)) throw new Error("Неизвестный итог рассмотрения запроса.");
  const id = Number(requestId);
  const when = new Date(resolvedAt);
  if (!Number.isSafeInteger(id) || id <= 0 || Number.isNaN(when.getTime()) || when.getTime() > Date.now()) throw new Error("Параметры рассмотрения запроса некорректны.");
  return db.transaction(() => {
    const updated = db.prepare("UPDATE consent_withdrawal_requests SET status=?, resolved_at=? WHERE id=? AND status='pending_review'").run(resolution, when.toISOString(), id);
    if (updated.changes === 1) return { status: resolution, request_id: id, resolved_at: when.toISOString() };
    const current = getConsentWithdrawalRequest(id);
    return current ? { status: "already_resolved", request_id: id, request_status: current.status, resolved_at: current.resolved_at } : { status: "not_found", request_id: id };
  }).immediate();
}
function createParticipantDeletionRequestForTelegram(telegramId, requestId, requestedAt = new Date().toISOString()) {
  const actor = String(telegramId ?? "");
  const request = String(requestId ?? "");
  const when = new Date(requestedAt);
  if (!/^\d+$/.test(actor) || !/^[0-9a-f-]{36}$/i.test(request) || Number.isNaN(when.getTime()) || when.getTime() > Date.now()) throw new Error("Параметры запроса удаления анкеты некорректны.");
  return db.transaction(() => {
    const owner = db.prepare("SELECT p.id FROM participants p JOIN accounts a ON a.participant_id=p.id WHERE a.platform='telegram' AND a.messenger_user_id=?").get(actor);
    if (!owner) return { status: "not_found" };
    const existing = db.prepare("SELECT request_id,requested_at,status FROM participant_deletion_requests WHERE participant_id=? AND status='pending_review'").get(owner.id);
    if (existing) return { ...existing, status: "already_requested", request_status: existing.status };
    db.prepare("INSERT INTO participant_deletion_requests(request_id,participant_id,requested_at,status) VALUES(?,?,?,'pending_review')").run(request, owner.id, when.toISOString());
    return { status: "received", request_id: request, requested_at: when.toISOString(), request_status: "pending_review" };
  }).immediate();
}
function getParticipantDataRequestsForTelegram(telegramId) {
  const actor = String(telegramId ?? "");
  if (!/^\d+$/.test(actor)) return null;
  return db.prepare(`SELECT p.id AS participant_id, p.personal_data_consent, p.consent_at, p.consent_version, p.consent_withdrawn_at,
      (SELECT d.request_id FROM participant_deletion_requests d WHERE d.participant_id=p.id ORDER BY d.requested_at DESC LIMIT 1) AS deletion_request_id,
      (SELECT d.requested_at FROM participant_deletion_requests d WHERE d.participant_id=p.id ORDER BY d.requested_at DESC LIMIT 1) AS deletion_requested_at,
      (SELECT d.status FROM participant_deletion_requests d WHERE d.participant_id=p.id ORDER BY d.requested_at DESC LIMIT 1) AS deletion_request_status,
      (SELECT CAST(c.id AS TEXT) FROM consent_withdrawal_requests c WHERE c.participant_id=p.id ORDER BY c.requested_at DESC LIMIT 1) AS consent_request_id,
      (SELECT c.requested_at FROM consent_withdrawal_requests c WHERE c.participant_id=p.id ORDER BY c.requested_at DESC LIMIT 1) AS consent_requested_at,
      (SELECT c.status FROM consent_withdrawal_requests c WHERE c.participant_id=p.id ORDER BY c.requested_at DESC LIMIT 1) AS consent_request_status
    FROM participants p JOIN accounts a ON a.participant_id=p.id
    WHERE a.platform='telegram' AND a.messenger_user_id=?`).get(actor) ?? null;
}
function listParticipantDataRequests(limit = 50, offset = 0) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
  const parsedOffset = Number(offset);
  const safeOffset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? Math.min(parsedOffset, 1_000_000_000) : 0;
  return db.prepare(`SELECT request_type, request_id, requested_at, status FROM (
      SELECT 'deletion' AS request_type, request_id, requested_at, status FROM participant_deletion_requests
      UNION ALL
      SELECT 'consent_withdrawal' AS request_type, CAST(id AS TEXT) AS request_id, requested_at, status FROM consent_withdrawal_requests
    ) ORDER BY requested_at DESC, request_type, request_id LIMIT ? OFFSET ?`).all(safeLimit, safeOffset);
}
function listDemoTestDeletionRequests(limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 50));
  return db.prepare(`SELECT d.request_id, d.participant_id, d.requested_at, d.status
    FROM participant_deletion_requests d JOIN demo_test_participants t ON t.participant_id=d.participant_id
    WHERE d.status='pending_review' ORDER BY d.requested_at,d.request_id LIMIT ?`).all(safeLimit);
}
function getParticipantDataRequestCount() {
  return db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT request_id FROM participant_deletion_requests
      UNION ALL
      SELECT id FROM consent_withdrawal_requests
    )`).get().count;
}
function recordTelegramPrivateChat(telegramId, at = new Date().toISOString()) {
  const id = String(telegramId ?? "");
  const timestamp = new Date(at);
  if (!/^\d{1,20}$/.test(id) || Number.isNaN(timestamp.getTime())) return false;
  const value = timestamp.toISOString();
  db.prepare(`INSERT INTO telegram_private_chats(telegram_id,first_seen_at,last_seen_at) VALUES(?,?,?)
    ON CONFLICT(telegram_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(id, value, value);
  return true;
}
function hasTelegramPrivateChat(telegramId) {
  const id = String(telegramId ?? "");
  return /^\d{1,20}$/.test(id) && Boolean(db.prepare("SELECT 1 FROM telegram_private_chats WHERE telegram_id=?").get(id));
}
function closeDatabase() { db.close(); }
module.exports = { db, dbPath, schemaVersion: CURRENT_SCHEMA_VERSION, normalizePhone, addParticipant, registerParticipant, createDemoTestParticipant, isDemoTestParticipant, isDemoTestParticipantForTelegram, findParticipantByPhone, findParticipantByTelegramId, findParticipantByTelegramIdIncludingWithdrawn, listLinkedPlatformsForTelegram, listAccountLinkRequestsForTelegram, getAccountLinkRequestForTelegram, getParticipant, getParticipantIncludingWithdrawn, searchParticipants, listParticipants, updateParticipant, updateParticipantIfUnchanged, updatePhoneFromVerifiedTelegramContact, linkAccount, createAccountLinkRequest, transitionAccountLinkRequest, completeAccountLinkRequest, saveDraft, getDraft, beginProfileEditDraft, hasDraft, deleteDraft, getAdminRole, initializeOwner, transferOwner, updateAdminUsername, listAdmins, addAdmin, removeAdmin, getParticipantCount, getParticipantStatistics, getParticipantsForExport, getParticipantDeletionPreview, deleteParticipantById, deleteDemoTestParticipantById, getParticipantConsentState, recordConsentWithdrawalRequest, getConsentWithdrawalRequest, resolveConsentWithdrawalRequest, createParticipantDeletionRequestForTelegram, getParticipantDataRequestsForTelegram, listParticipantDataRequests, listDemoTestDeletionRequests, getParticipantDataRequestCount, recordTelegramPrivateChat, hasTelegramPrivateChat, closeDatabase };

