const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { getDatabasePath } = require("./config");

const dbPath = getDatabasePath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath, { timeout: 5000 });
// Normalize only for comparisons: Russian ё and е are equivalent in participant search.
// Latin e remains unchanged because the replacement applies only to Cyrillic ё.
const normalizeSearchText = (value) => String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
db.function("unicode_lower", { deterministic: true }, normalizeSearchText);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT NOT NULL UNIQUE CHECK (phone GLOB '+[0-9]*' AND length(phone) BETWEEN 8 AND 16),
  city TEXT,
  email TEXT,
  preferred_contact TEXT,
  referral_source TEXT,
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  phone_confirmed_at TEXT,
  personal_data_consent INTEGER NOT NULL DEFAULT 0 CHECK(personal_data_consent IN (0,1))
);
`);
if (!db.prepare("PRAGMA table_info(participants)").all().some((column) => column.name === "consent_at")) {
  db.exec("ALTER TABLE participants ADD COLUMN consent_at TEXT");
}
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),
  messenger_user_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(platform, messenger_user_id), UNIQUE(participant_id, platform)
);
CREATE TABLE IF NOT EXISTS admins (
  telegram_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('owner','admin')),
  username TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS registration_drafts (
  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),
  messenger_user_id TEXT NOT NULL,
  current_step TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(platform, messenger_user_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_participant ON accounts(participant_id);
`);
// Older databases may already have admins without the optional username column.
if (!db.prepare("PRAGMA table_info(admins)").all().some((column) => column.name === "username")) {
  db.exec("ALTER TABLE admins ADD COLUMN username TEXT");
}

function normalizePhone(phone) {
  const normalized = String(phone).replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("Телефон должен быть в международном формате, например +79001234567");
  return normalized;
}
function addParticipant(data, account = null) {
  const insert = db.prepare(`INSERT INTO participants(first_name,last_name,phone,city,email,preferred_contact,referral_source,phone_confirmed_at,personal_data_consent,consent_at)
    VALUES(@first_name,@last_name,@phone,@city,@email,@preferred_contact,@referral_source,@phone_confirmed_at,@personal_data_consent,@consent_at)`);
  const transaction = db.transaction(() => {
    const result = insert.run({ first_name: data.first_name, last_name: data.last_name ?? null, phone: normalizePhone(data.phone), city: data.city ?? null, email: data.email ?? null, preferred_contact: data.preferred_contact ?? null, referral_source: data.referral_source ?? null, phone_confirmed_at: data.phone_confirmed_at ?? null, personal_data_consent: data.personal_data_consent ? 1 : 0, consent_at: data.consent_at ?? null });
    if (account) linkAccount(result.lastInsertRowid, account.platform, account.messenger_user_id);
    return getParticipant(result.lastInsertRowid);
  });
  return transaction();
}
function findParticipantByPhone(phone) { return db.prepare("SELECT * FROM participants WHERE phone=?").get(normalizePhone(phone)); }
function findParticipantByTelegramId(id) { return db.prepare("SELECT p.* FROM participants p JOIN accounts a ON a.participant_id=p.id WHERE a.platform='telegram' AND a.messenger_user_id=?").get(String(id)); }
function getParticipant(id) { return db.prepare("SELECT * FROM participants WHERE id=?").get(id); }
function searchParticipants(query, limit = 50, offset = 0) {
  const term = String(query ?? "").trim();
  if (!term) return [];
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const phoneDigits = term.replace(/\D/g, "");
  const isPhone = phoneDigits.length >= 7 && phoneDigits.length <= 15 && /^[+\d\s().-]+$/.test(term);
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  if (isPhone) return db.prepare(`SELECT * FROM participants WHERE replace(phone,'+','')=? ORDER BY registered_at DESC,id DESC LIMIT ? OFFSET ?`).all(phoneDigits, safeLimit, safeOffset);
  const pattern = `%${normalizeSearchText(escaped)}%`;
  return db.prepare(`SELECT * FROM participants WHERE unicode_lower(first_name) LIKE ? ESCAPE '\\' OR unicode_lower(COALESCE(last_name,'')) LIKE ? ESCAPE '\\' OR unicode_lower(first_name || ' ' || COALESCE(last_name,'')) LIKE ? ESCAPE '\\' ORDER BY registered_at DESC,id DESC LIMIT ? OFFSET ?`).all(pattern, pattern, pattern, safeLimit, safeOffset);
}
function listParticipants(limit = 10, offset = 0) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 100));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  return db.prepare("SELECT id, first_name, last_name, city, registered_at FROM participants ORDER BY registered_at DESC,id DESC LIMIT ? OFFSET ?").all(safeLimit, safeOffset);
}
function updateParticipant(id, fields) {
  const allowed = new Set(["first_name","last_name","phone","city","email","preferred_contact","referral_source","phone_confirmed_at","personal_data_consent"]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return getParticipant(id);
  const assignments = entries.map(([key]) => `${key}=@${key}`).join(", ");
  const values = Object.fromEntries(entries);
  if (values.phone !== undefined) values.phone = normalizePhone(values.phone);
  if (values.personal_data_consent !== undefined) values.personal_data_consent = values.personal_data_consent ? 1 : 0;
  db.prepare(`UPDATE participants SET ${assignments}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run({ ...values, id });
  return getParticipant(id);
}
function linkAccount(participantId, platform, messengerUserId) {
  if (!["telegram", "max"].includes(platform)) throw new Error("Неизвестная платформа");
  const target = String(messengerUserId);
  const exists = db.prepare("SELECT participant_id FROM accounts WHERE platform=? AND messenger_user_id=?").get(platform, target);
  if (exists && Number(exists.participant_id) !== Number(participantId)) throw new Error("Этот аккаунт уже привязан к другому участнику");
  db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,?,?) ON CONFLICT(platform,messenger_user_id) DO NOTHING").run(participantId, platform, target);
  return db.prepare("SELECT * FROM accounts WHERE platform=? AND messenger_user_id=?").get(platform, target);
}
function saveDraft(platform, userId, step, answers) { db.prepare(`INSERT INTO registration_drafts(platform,messenger_user_id,current_step,answers_json,updated_at) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(platform,messenger_user_id) DO UPDATE SET current_step=excluded.current_step,answers_json=excluded.answers_json,updated_at=excluded.updated_at`).run(platform,String(userId),step,JSON.stringify(answers)); }
function getDraft(platform, userId) { const row=db.prepare("SELECT * FROM registration_drafts WHERE platform=? AND messenger_user_id=?").get(platform,String(userId)); return row ? {...row, answers: JSON.parse(row.answers_json)} : undefined; }
function hasDraft(platform, userId) { return Boolean(db.prepare("SELECT 1 FROM registration_drafts WHERE platform=? AND messenger_user_id=?").get(platform,String(userId))); }
function deleteDraft(platform, userId) { return db.prepare("DELETE FROM registration_drafts WHERE platform=? AND messenger_user_id=?").run(platform,String(userId)).changes > 0; }
function getAdminRole(telegramId) { return db.prepare("SELECT role FROM admins WHERE telegram_id=?").get(String(telegramId))?.role ?? null; }
function initializeOwner(telegramId) {
  if (!/^\d+$/.test(String(telegramId || ""))) return false;
  const result = db.prepare("INSERT INTO admins(telegram_id,role) SELECT ?, 'owner' WHERE NOT EXISTS (SELECT 1 FROM admins WHERE role='owner')").run(String(telegramId));
  return result.changes > 0 || getAdminRole(telegramId) === "owner";
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
function getParticipantCount() { return db.prepare("SELECT COUNT(*) AS count FROM participants").get().count; }
function getParticipantStatistics() {
  const totals = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN registered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') THEN 1 ELSE 0 END) AS last_7_days,
    SUM(CASE WHEN registered_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') THEN 1 ELSE 0 END) AS last_30_days
    FROM participants`).get();
  const groupQuery = (column) => db.prepare(`WITH grouped AS (
      SELECT COALESCE(NULLIF(trim(${column}), ''), 'Не указано') AS category, COUNT(*) AS count
      FROM participants GROUP BY category
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
      telegram.messenger_user_id AS telegram_id, max_account.messenger_user_id AS max_id
    FROM participants AS p
    LEFT JOIN accounts AS telegram ON telegram.participant_id=p.id AND telegram.platform='telegram'
    LEFT JOIN accounts AS max_account ON max_account.participant_id=p.id AND max_account.platform='max'
    ORDER BY p.id ASC`).all();
}
function closeDatabase() { db.close(); }
module.exports = { db, dbPath, normalizePhone, addParticipant, findParticipantByPhone, findParticipantByTelegramId, getParticipant, searchParticipants, listParticipants, updateParticipant, linkAccount, saveDraft, getDraft, hasDraft, deleteDraft, getAdminRole, initializeOwner, updateAdminUsername, listAdmins, addAdmin, removeAdmin, getParticipantCount, getParticipantStatistics, getParticipantsForExport, closeDatabase };

