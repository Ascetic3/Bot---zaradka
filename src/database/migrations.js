const CORE_TABLES = ["participants", "accounts", "admins", "registration_drafts"];
const CURRENT_SCHEMA_VERSION = 11;

const BASE_COLUMNS = {
  participants: ["id", "first_name", "last_name", "phone", "city", "email", "preferred_contact", "referral_source", "registered_at", "updated_at", "phone_confirmed_at", "personal_data_consent"],
  accounts: ["id", "participant_id", "platform", "messenger_user_id", "linked_at"],
  admins: ["telegram_id", "role", "added_at"],
  registration_drafts: ["platform", "messenger_user_id", "current_step", "answers_json", "updated_at"]
};
const OPTIONAL_KNOWN_COLUMNS = {
  participants: new Set(["consent_at", "consent_version", "consent_withdrawn_at"]),
  admins: new Set(["username"])
};
const TYPES = {
  participants: { id: "INTEGER", first_name: "TEXT", last_name: "TEXT", phone: "TEXT", city: "TEXT", email: "TEXT", preferred_contact: "TEXT", referral_source: "TEXT", registered_at: "TEXT", updated_at: "TEXT", phone_confirmed_at: "TEXT", personal_data_consent: "INTEGER", consent_at: "TEXT", consent_version: "TEXT", consent_withdrawn_at: "TEXT" },
  accounts: { id: "INTEGER", participant_id: "INTEGER", platform: "TEXT", messenger_user_id: "TEXT", linked_at: "TEXT" },
  admins: { telegram_id: "TEXT", role: "TEXT", added_at: "TEXT", username: "TEXT" },
  registration_drafts: { platform: "TEXT", messenger_user_id: "TEXT", current_step: "TEXT", answers_json: "TEXT", updated_at: "TEXT" }
};

const createBaseSchema = (db) => db.exec(`
  CREATE TABLE participants (
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
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),
    messenger_user_id TEXT NOT NULL,
    linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(platform, messenger_user_id), UNIQUE(participant_id, platform)
  );
  CREATE TABLE admins (
    telegram_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('owner','admin')),
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE registration_drafts (
    platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),
    messenger_user_id TEXT NOT NULL,
    current_step TEXT NOT NULL,
    answers_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(platform, messenger_user_id)
  );
  CREATE INDEX idx_accounts_participant ON accounts(participant_id);
`);

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => name);
}
function columns(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all(); }
function columnMap(db, table) { return new Map(columns(db, table).map((c) => [c.name, c])); }
function normalizeSql(value) { return String(value || "").toLowerCase().replace(/[\s`"]+/g, ""); }
function indexes(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((index) => ({ ...index, columns: db.prepare(`PRAGMA index_info(${index.name})`).all().map((c) => c.name) }));
}
function hasUnique(db, table, expectedColumns) {
  return indexes(db, table).some((index) => index.unique && JSON.stringify(index.columns) === JSON.stringify(expectedColumns));
}
function checkExpressions(sql) {
  const source = String(sql || "");
  const expressions = [];
  const matcher = /\bCHECK\s*\(/ig;
  let match;
  while ((match = matcher.exec(source))) {
    const start = matcher.lastIndex;
    let depth = 1;
    let quote = null;
    let end = start;
    for (; end < source.length && depth > 0; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === quote && source[end + 1] === quote) end += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth !== 0) throw new Error("Структура SQLite содержит незакрытое CHECK-ограничение.");
    expressions.push(normalizeSql(source.slice(start, end - 1)));
    matcher.lastIndex = end;
  }
  return expressions.sort();
}
function assertColumns(db, table, expectedVersion, legacyFlexible = false) {
  const actual = columnMap(db, table);
  const allowed = new Set(BASE_COLUMNS[table]);
  if (table === "participants" && expectedVersion >= 2) allowed.add("consent_at");
  if (table === "participants" && expectedVersion >= 3) allowed.add("consent_version");
  if (table === "participants" && expectedVersion >= 5) allowed.add("consent_withdrawn_at");
  if (table === "admins" && expectedVersion >= 4) allowed.add("username");
  if (legacyFlexible) for (const name of OPTIONAL_KNOWN_COLUMNS[table] || []) if (actual.has(name)) allowed.add(name);
  const missing = [...allowed].filter((name) => !actual.has(name));
  const unknown = [...actual.keys()].filter((name) => !allowed.has(name));
  if (missing.length || unknown.length) throw new Error(`Несовместимая схема таблицы ${table}: отсутствуют или неизвестны столбцы.`);
  for (const [name, info] of actual) {
    if (String(info.type).toUpperCase() !== TYPES[table][name]) throw new Error(`Несовместимый тип столбца ${table}.${name}.`);
  }
  const requiredNotNull = table === "participants"
    ? ["first_name", "phone", "registered_at", "updated_at", "personal_data_consent"]
    : table === "accounts" ? ["participant_id", "platform", "messenger_user_id", "linked_at"]
      : table === "admins" ? ["role", "added_at"] : ["platform", "messenger_user_id", "current_step", "answers_json", "updated_at"];
  for (const name of requiredNotNull) if (!actual.get(name)?.notnull) throw new Error(`Нарушено обязательное ограничение ${table}.${name} NOT NULL.`);
  if (table === "participants" && (!actual.get("id")?.pk || !hasUnique(db, table, ["phone"]))) throw new Error("Нет ожидаемого ключа участника или уникальности телефона.");
  if (table === "accounts") {
    if (!actual.get("id")?.pk || !hasUnique(db, table, ["platform", "messenger_user_id"]) || !hasUnique(db, table, ["participant_id", "platform"])) throw new Error("Ограничения уникальности accounts не соответствуют ожидаемой схеме.");
    const fks = db.prepare("PRAGMA foreign_key_list(accounts)").all();
    if (!fks.some((fk) => fk.table === "participants" && fk.from === "participant_id" && fk.to === "id" && fk.on_delete.toUpperCase() === "CASCADE")) throw new Error("В accounts отсутствует ожидаемая связь с participants.");
    if (!indexes(db, table).some((index) => index.name === "idx_accounts_participant" && JSON.stringify(index.columns) === JSON.stringify(["participant_id"]))) throw new Error("Отсутствует индекс idx_accounts_participant.");
  }
  if (table === "admins" && !actual.get("telegram_id")?.pk) throw new Error("telegram_id должен оставаться первичным ключом admins.");
  if (table === "registration_drafts" && !(actual.get("platform")?.pk === 1 && actual.get("messenger_user_id")?.pk === 2)) throw new Error("Ключ черновиков регистрации не соответствует ожидаемой схеме.");
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  const checks = table === "participants"
    ? ["phoneglob'+[0-9]*'andlength(phone)between8and16", "personal_data_consentin(0,1)"]
      : table === "accounts" ? ["platformin('telegram','max')"]
        : table === "admins" ? ["rolein('owner','admin')"]
          : ["platformin('telegram','max')"];
  if (JSON.stringify(checkExpressions(sql)) !== JSON.stringify(checks.sort())) throw new Error(`Проверочные ограничения таблицы ${table} не совпадают с поддерживаемой схемой.`);
}

function inspectSchema(db, { allowKnownOptionalColumns = true } = {}) {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION) throw new Error(`Неизвестная версия SQLite-схемы: ${version}.`);
  const names = tableNames(db);
  const unsupportedViews = db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type='view' LIMIT 1").get();
  if (unsupportedViews) throw new Error("Структура SQLite содержит неизвестные представления; автоматическое обновление остановлено.");
  if (version === 0 && names.length === 0) return { version, structuralVersion: 0, empty: true, legacyUnversioned: false, tables: [] };
  if (!CORE_TABLES.every((table) => names.includes(table))) throw new Error("Структура SQLite не распознана: отсутствуют обязательные таблицы.");
  const allowedTables = new Set([...CORE_TABLES, "demo_seed_metadata", "consent_withdrawal_requests", "account_link_requests", "participant_deletion_requests", "demo_test_participants", "meetings", "meeting_broadcasts", "meeting_deliveries", "telegram_private_chats", "meeting_send_rate_limit_state"]);
  if (names.some((name) => !allowedTables.has(name))) throw new Error("Структура SQLite содержит неизвестные таблицы; автоматическое обновление остановлено.");
  const explicitIndexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  const expectedIndexes = new Map([["idx_accounts_participant", "accounts"], ["idx_account_link_requests_participant", "account_link_requests"], ["uq_account_link_requests_target_active", "account_link_requests"], ["idx_participant_deletion_requests_status", "participant_deletion_requests"], ["uq_participant_deletion_requests_active", "participant_deletion_requests"]]);
  if (names.includes("demo_test_participants")) expectedIndexes.set("idx_demo_test_participants_created_at", "demo_test_participants");
  if (names.includes("meeting_broadcasts")) { expectedIndexes.set("idx_meeting_broadcasts_due", "meeting_broadcasts"); expectedIndexes.set("idx_meeting_broadcasts_meeting", "meeting_broadcasts"); }
  if (names.includes("meeting_deliveries")) { expectedIndexes.set("idx_meeting_deliveries_due", "meeting_deliveries"); expectedIndexes.set("uq_meeting_deliveries_recipient", "meeting_deliveries"); }
  if (names.includes("telegram_private_chats")) expectedIndexes.set("idx_telegram_private_chats_last_seen", "telegram_private_chats");
  const expectedIndexCount = 1 + (names.includes("account_link_requests") ? 2 : 0) + (names.includes("participant_deletion_requests") ? 2 : 0) + (names.includes("demo_test_participants") ? 1 : 0) + (names.includes("meeting_broadcasts") ? 2 : 0) + (names.includes("meeting_deliveries") ? 2 : 0) + (names.includes("telegram_private_chats") ? 1 : 0);
  if (explicitIndexes.some((index) => expectedIndexes.get(index.name) !== index.tbl_name) || explicitIndexes.length !== expectedIndexCount) throw new Error("Набор пользовательских индексов SQLite не совпадает с поддерживаемой схемой.");
  const accountParticipantIndex = indexes(db, "accounts").find((index) => index.name === "idx_accounts_participant");
  if (!accountParticipantIndex || accountParticipantIndex.unique || accountParticipantIndex.partial || JSON.stringify(accountParticipantIndex.columns) !== JSON.stringify(["participant_id"])) throw new Error("Индекс accounts.participant_id не совпадает с поддерживаемой схемой.");
  // Only a version-0 database is treated as an unversioned legacy database.
  // A nonzero marker must match the exact schema for that version.
  const legacyFlexible = version === 0 && allowKnownOptionalColumns;
  for (const table of CORE_TABLES) assertColumns(db, table, version, legacyFlexible);
  let structuralVersion = version;
  if (version === 0) {
    const participants = columnMap(db, "participants");
    const admins = columnMap(db, "admins");
    const hasWithdrawalTimestamp = participants.has("consent_withdrawn_at");
    const hasWithdrawalTable = names.includes("consent_withdrawal_requests");
    if (hasWithdrawalTimestamp !== hasWithdrawalTable) throw new Error("Структура согласия противоречива: отметка отзыва и таблица запросов должны присутствовать вместе.");
    const hasLinkRequestTable = names.includes("account_link_requests");
    const present = [
      participants.has("consent_at"),
      participants.has("consent_version"),
      admins.has("username"),
      hasWithdrawalTimestamp,
      hasLinkRequestTable,
      names.includes("participant_deletion_requests")
    ];
    let gap = false;
    let completed = 0;
    for (const exists of present) {
      if (!exists) gap = true;
      else {
        if (gap) throw new Error("Структура версии 0 противоречива: найдены столбцы более поздних миграций при отсутствии предыдущих.");
        completed += 1;
      }
    }
    structuralVersion = 1 + completed;
    if (names.includes("participant_deletion_requests")) {
      const hasHistoricalParticipantUnique = indexes(db, "participant_deletion_requests")
        .some((index) => index.unique && !index.partial && JSON.stringify(index.columns) === JSON.stringify(["participant_id"]));
      structuralVersion = hasHistoricalParticipantUnique ? 7 : 8;
    }
    // Revalidate against the inferred exact version, including rejecting any
    // unrecognized columns and checking the constraints expected at that point.
    for (const table of CORE_TABLES) assertColumns(db, table, structuralVersion, false);
  }
  const effectiveVersion = version === 0 ? structuralVersion : version;
  const expectedWithdrawalSchema = effectiveVersion >= 5;
  if (expectedWithdrawalSchema !== names.includes("consent_withdrawal_requests")) throw new Error("Таблица запросов отзыва согласия не соответствует версии схемы.");
  if (expectedWithdrawalSchema) assertWithdrawalSchema(db);
  const expectedAccountLinkSchema = effectiveVersion >= 6;
  if (expectedAccountLinkSchema !== names.includes("account_link_requests")) throw new Error("Таблица запросов связывания аккаунтов не соответствует версии схемы.");
  if (expectedAccountLinkSchema) assertAccountLinkRequestSchema(db);
  const expectedDeletionSchema = effectiveVersion >= 7;
  if (expectedDeletionSchema !== names.includes("participant_deletion_requests")) throw new Error("Таблица запросов удаления анкеты не соответствует версии схемы.");
  if (expectedDeletionSchema) assertParticipantDeletionRequestSchema(db, effectiveVersion);
  const triggerNames = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => name);
  if (JSON.stringify(triggerNames.sort()) !== JSON.stringify((expectedAccountLinkSchema ? ["trg_account_link_requests_state_transition"] : []).sort())) throw new Error("Набор триггеров SQLite не совпадает с поддерживаемой схемой.");
  if (names.includes("demo_seed_metadata")) {
    const meta = columnMap(db, "demo_seed_metadata");
    const expected = ["seed_name", "seed_version", "seeded_at", "participant_count"];
    const expectedTypes = { seed_name: "TEXT", seed_version: "INTEGER", seeded_at: "TEXT", participant_count: "INTEGER" };
    if (expected.some((name) => !meta.has(name) || String(meta.get(name).type).toUpperCase() !== expectedTypes[name]) || meta.size !== expected.length || !meta.get("seed_name").pk || expected.slice(1).some((name) => !meta.get(name).notnull)) throw new Error("Таблица метаданных демобазы имеет неизвестную структуру.");
  }
  if (names.includes("demo_test_participants")) assertDemoTestParticipantsSchema(db);
  if ((effectiveVersion >= 9) !== names.includes("demo_test_participants")) throw new Error("Таблица меток тестовых демо-анкет не соответствует версии схемы.");
  const hasMeetingSchema = ["meetings", "meeting_broadcasts", "meeting_deliveries"].every((table) => names.includes(table));
  const hasAnyMeetingTable = ["meetings", "meeting_broadcasts", "meeting_deliveries"].some((table) => names.includes(table));
  if ((effectiveVersion >= 10) !== hasMeetingSchema || (hasAnyMeetingTable && !hasMeetingSchema)) throw new Error("Таблицы встреч и рассылок не соответствуют версии схемы.");
  if (hasMeetingSchema) assertMeetingBroadcastSchema(db);
  if ((effectiveVersion >= 10) !== names.includes("telegram_private_chats")) throw new Error("Таблица подтверждённых личных чатов не соответствует версии схемы.");
  if (names.includes("telegram_private_chats")) assertTelegramPrivateChatsSchema(db);
  if ((effectiveVersion >= 11) !== names.includes("meeting_send_rate_limit_state")) throw new Error("Таблица общего ограничения отправки не соответствует версии схемы.");
  if (names.includes("meeting_send_rate_limit_state")) assertMeetingSendRateLimitSchema(db);
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error("В SQLite найдены нарушенные связи между таблицами.");
  return { version, structuralVersion, empty: false, legacyUnversioned: version === 0, tables: names };
}

const migrationLabels = new Map([
  [1, "Создание базовой схемы"],
  [2, "Добавление времени согласия"],
  [3, "Добавление версии согласия"],
  [4, "Добавление username администратора"],
  [5, "Технический учёт отзыва согласия"],
  [6, "Запросы безопасного связывания аккаунтов"],
  [7, "Запросы участников на удаление анкеты"],
  [8, "Повторные запросы удаления после завершения предыдущего"],
  [9, "Маркировка тестовых анкет деморежима"],
  [10, "Планирование Zoom-встреч и история рассылок"],
  [11, "Общее ограничение скорости Zoom-рассылок"]
]);

function assertDemoTestParticipantsSchema(db) {
  const table = "demo_test_participants";
  const actual = columnMap(db, table);
  const expected = { participant_id: "INTEGER", created_at: "TEXT" };
  if (actual.size !== 2 || Object.entries(expected).some(([name, type]) => !actual.has(name) || String(actual.get(name).type).toUpperCase() !== type)) throw new Error("Структура demo_test_participants не соответствует поддерживаемой схеме.");
  if (actual.get("participant_id").pk !== 1 || !actual.get("created_at").notnull || !String(actual.get("created_at").dflt_value || "").toLowerCase().includes("strftime")) throw new Error("Ограничения demo_test_participants не соответствуют схеме.");
  const fk = db.prepare("PRAGMA foreign_key_list(demo_test_participants)").all();
  if (fk.length !== 1 || !fk.some((item) => item.table === "participants" && item.from === "participant_id" && item.to === "id" && item.on_delete.toUpperCase() === "CASCADE")) throw new Error("Метка тестовой анкеты должна удаляться каскадно вместе с участником.");
  const index = indexes(db, table).find((item) => item.name === "idx_demo_test_participants_created_at");
  const indexSql = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_demo_test_participants_created_at'").get()?.sql);
  if (!index || index.unique || index.partial || JSON.stringify(index.columns) !== JSON.stringify(["created_at"]) || indexSql !== "createindexidx_demo_test_participants_created_atondemo_test_participants(created_at)") throw new Error("Индекс demo_test_participants.created_at не соответствует схеме.");
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  if (checkExpressions(tableSql).length) throw new Error("В схеме меток тестовых анкет найдены неподдерживаемые ограничения.");
}

function assertParticipantDeletionRequestSchema(db, version = CURRENT_SCHEMA_VERSION) {
  const table = "participant_deletion_requests";
  const actual = columnMap(db, table);
  const expected = { id: "INTEGER", request_id: "TEXT", participant_id: "INTEGER", requested_at: "TEXT", status: "TEXT" };
  if (actual.size !== Object.keys(expected).length || Object.entries(expected).some(([name, type]) => !actual.has(name) || String(actual.get(name).type).toUpperCase() !== type)) throw new Error("Структура participant_deletion_requests не соответствует поддерживаемой схеме.");
  const tableIndexes = indexes(db, table);
  const requestIdUnique = tableIndexes.some((index) => index.unique && !index.partial && JSON.stringify(index.columns) === JSON.stringify(["request_id"]));
  const participantIdUnique = tableIndexes.some((index) => index.unique && !index.partial && JSON.stringify(index.columns) === JSON.stringify(["participant_id"]));
  if (!actual.get("id").pk || !actual.get("request_id").notnull || actual.get("participant_id").notnull || !actual.get("requested_at").notnull || !actual.get("status").notnull || actual.get("status").dflt_value !== "'pending_review'" || !requestIdUnique || participantIdUnique !== (version === 7)) throw new Error("Ограничения запросов удаления анкеты не соответствуют схеме.");
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  if (!fks.some((fk) => fk.table === "participants" && fk.from === "participant_id" && fk.to === "id" && fk.on_delete.toUpperCase() === "SET NULL")) throw new Error("Запрос удаления должен обезличиваться при удалении участника.");
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  if (JSON.stringify(checkExpressions(sql)) !== JSON.stringify(["statusin('pending_review','processed','not_applicable')"])) throw new Error("Допустимые состояния запроса удаления анкеты не совпадают со схемой.");
  const statusIndex = tableIndexes.find((item) => item.name === "idx_participant_deletion_requests_status");
  const indexSql = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_participant_deletion_requests_status'").get()?.sql);
  const activeIndex = tableIndexes.find((item) => item.name === "uq_participant_deletion_requests_active");
  const activeSql = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_participant_deletion_requests_active'").get()?.sql);
  if (!statusIndex || statusIndex.unique || statusIndex.partial || JSON.stringify(statusIndex.columns) !== JSON.stringify(["status", "requested_at"]) || indexSql !== "createindexidx_participant_deletion_requests_statusonparticipant_deletion_requests(status,requested_at)" || !activeIndex?.unique || !activeIndex.partial || JSON.stringify(activeIndex.columns) !== JSON.stringify(["participant_id"]) || activeSql !== "createuniqueindexuq_participant_deletion_requests_activeonparticipant_deletion_requests(participant_id)wherestatus='pending_review'") throw new Error("Индексы запросов удаления анкеты не соответствуют схеме.");
}

function assertAccountLinkRequestSchema(db) {
  const table = "account_link_requests";
  const actual = columnMap(db, table);
  const expected = { request_id: "TEXT", participant_id: "INTEGER", target_platform: "TEXT", target_account_id: "TEXT", target_verified_at: "TEXT", target_proof_method: "TEXT", state: "TEXT", created_at: "TEXT", expires_at: "TEXT", participant_updated_at: "TEXT", decision_by_platform: "TEXT", decision_by_account_id: "TEXT", decision_at: "TEXT", completed_at: "TEXT" };
  if (actual.size !== Object.keys(expected).length || Object.entries(expected).some(([name, type]) => !actual.has(name) || String(actual.get(name).type).toUpperCase() !== type)) throw new Error("Структура account_link_requests не соответствует поддерживаемой схеме.");
  if (!actual.get("request_id").pk || ["participant_id", "target_platform", "target_account_id", "target_verified_at", "target_proof_method", "state", "created_at", "expires_at", "participant_updated_at"].some((name) => !actual.get(name).notnull)) throw new Error("Обязательные ограничения account_link_requests не соответствуют схеме.");
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  if (!fks.some((fk) => fk.table === "participants" && fk.from === "participant_id" && fk.to === "id" && fk.on_delete.toUpperCase() === "CASCADE")) throw new Error("Запросы связывания не связаны с участниками каскадным внешним ключом.");
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  const checks = ["target_platformin('telegram','max')", "statein('pending','approved','consumed','rejected','cancelled','expired')"];
  if (JSON.stringify(checkExpressions(sql)) !== JSON.stringify(checks.sort())) throw new Error("Ограничения платформы и состояния запроса связывания не совпадают со схемой.");
  const requestIndexes = indexes(db, table);
  const participantIndex = requestIndexes.find((item) => item.name === "idx_account_link_requests_participant");
  const activeTarget = requestIndexes.find((item) => item.name === "uq_account_link_requests_target_active");
  const participantIndexSql = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_account_link_requests_participant'").get()?.sql);
  const activeTargetSql = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_account_link_requests_target_active'").get()?.sql);
  if (!participantIndex || participantIndex.unique || participantIndex.partial || JSON.stringify(participantIndex.columns) !== JSON.stringify(["participant_id", "state", "created_at"]) || participantIndexSql !== "createindexidx_account_link_requests_participantonaccount_link_requests(participant_id,state,created_at)" || !activeTarget || !activeTarget.unique || !activeTarget.partial || JSON.stringify(activeTarget.columns) !== JSON.stringify(["target_platform", "target_account_id"]) || activeTargetSql !== "createuniqueindexuq_account_link_requests_target_activeonaccount_link_requests(target_platform,target_account_id)wherestatein('pending','approved')") throw new Error("Индексы запросов связывания не соответствуют схеме.");
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_account_link_requests_state_transition'").get()?.sql;
  const normalizedTrigger = normalizeSql(trigger);
  const expectedTrigger = "createtriggertrg_account_link_requests_state_transitionbeforeupdateofstateonaccount_link_requestswhennot((old.state='pending'andnew.statein('approved','rejected','cancelled','expired'))or(old.state='approved'andnew.statein('consumed','cancelled','expired')))andold.state<>new.statebeginselectraise(abort,'invalidaccountlinkrequeststatetransition');end";
  if (normalizedTrigger !== expectedTrigger) throw new Error("Не найден защитный триггер переходов состояний запросов связывания.");
}

function assertWithdrawalSchema(db) {
  const actual = columnMap(db, "consent_withdrawal_requests");
  const expected = { id: "INTEGER", participant_id: "INTEGER", consent_at: "TEXT", requested_at: "TEXT", status: "TEXT", resolved_at: "TEXT" };
  if (actual.size !== Object.keys(expected).length || Object.entries(expected).some(([name, type]) => !actual.has(name) || String(actual.get(name).type).toUpperCase() !== type)) {
    throw new Error("Структура consent_withdrawal_requests не соответствует поддерживаемой схеме.");
  }
  if (!actual.get("id").pk || ["participant_id", "consent_at", "requested_at", "status"].some((name) => !actual.get(name).notnull)) {
    throw new Error("Ограничения обязательных полей consent_withdrawal_requests не соответствуют схеме.");
  }
  if (!hasUnique(db, "consent_withdrawal_requests", ["participant_id", "consent_at"])) throw new Error("В запросах отзыва согласия отсутствует защита от повтора.");
  const fks = db.prepare("PRAGMA foreign_key_list(consent_withdrawal_requests)").all();
  if (!fks.some((fk) => fk.table === "participants" && fk.from === "participant_id" && fk.to === "id" && fk.on_delete.toUpperCase() === "CASCADE")) throw new Error("Запросы отзыва согласия не связаны с участником каскадным внешним ключом.");
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='consent_withdrawal_requests'").get()?.sql;
  if (JSON.stringify(checkExpressions(sql)) !== JSON.stringify(["statusin('pending_review','processed','not_applicable')"])) throw new Error("Допустимые состояния запроса отзыва согласия не совпадают со схемой.");
}

function assertTelegramPrivateChatsSchema(db) {
  const table = "telegram_private_chats";
  const actual = columnMap(db, table);
  if (actual.size !== 3 || actual.get("telegram_id")?.type !== "TEXT" || !actual.get("telegram_id")?.pk || actual.get("first_seen_at")?.type !== "TEXT" || !actual.get("first_seen_at")?.notnull || actual.get("last_seen_at")?.type !== "TEXT" || !actual.get("last_seen_at")?.notnull) throw new Error("Структура telegram_private_chats не соответствует схеме v10.");
  const index = indexes(db, table).find((item) => item.name === "idx_telegram_private_chats_last_seen");
  const sql = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_telegram_private_chats_last_seen'").get()?.sql);
  if (!index || index.unique || index.partial || JSON.stringify(index.columns) !== JSON.stringify(["last_seen_at"]) || sql !== "createindexidx_telegram_private_chats_last_seenontelegram_private_chats(last_seen_at)") throw new Error("Индекс последней активности Telegram не соответствует схеме v10.");
  if (checkExpressions(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql).length) throw new Error("В telegram_private_chats найдены неизвестные ограничения.");
}

function assertMeetingSendRateLimitSchema(db) {
  const table = "meeting_send_rate_limit_state";
  const actual = columnMap(db, table);
  const expected = { singleton_id: "INTEGER", next_allowed_at: "TEXT", blocked_until: "TEXT",
    sender_token: "TEXT", sender_pid: "INTEGER", sender_host: "TEXT",
    sender_delivery_id: "INTEGER", sender_acquired_at: "TEXT" };
  if (actual.size !== Object.keys(expected).length || !actual.get("singleton_id")?.pk
      || Object.entries(expected).some(([name, type]) => actual.get(name)?.type !== type || actual.get(name)?.notnull)) {
    throw new Error("Структура общего ограничения отправки не соответствует схеме v11.");
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
  if (JSON.stringify(checkExpressions(sql)) !== JSON.stringify(["singleton_id=1"])) throw new Error("Ограничение единственной строки общего лимитера не соответствует схеме v11.");
  if (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count !== 1
      || !db.prepare(`SELECT 1 FROM ${table} WHERE singleton_id=1`).get()) throw new Error("В общем лимитере должна существовать ровно одна строка состояния.");
  const owner = db.prepare(`SELECT sender_token,sender_pid,sender_host,sender_delivery_id,sender_acquired_at FROM ${table} WHERE singleton_id=1`).get();
  if (Boolean(owner.sender_token) !== [owner.sender_pid, owner.sender_host, owner.sender_delivery_id, owner.sender_acquired_at].every((value) => value !== null)) {
    throw new Error("Состояние владельца отправки в схеме v11 противоречиво.");
  }
  if (db.prepare(`PRAGMA foreign_key_list(${table})`).all().length) throw new Error("У общего лимитера не должно быть внешних ключей.");
}

function assertMeetingBroadcastSchema(db) {
  const expectedTables = {
    meetings: { id: "INTEGER", title: "TEXT", starts_at: "TEXT", zoom_url: "TEXT", note: "TEXT", created_by: "TEXT", created_at: "TEXT" },
    meeting_broadcasts: { id: "INTEGER", meeting_id: "INTEGER", status: "TEXT", scheduled_at: "TEXT", timezone: "TEXT", created_by: "TEXT", created_at: "TEXT", updated_at: "TEXT", next_attempt_at: "TEXT", lease_owner: "TEXT", lease_until: "TEXT", attempt_count: "INTEGER", last_error_code: "TEXT" },
    meeting_deliveries: { id: "INTEGER", broadcast_id: "INTEGER", participant_id: "INTEGER", platform: "TEXT", messenger_user_id: "TEXT", status: "TEXT", attempt_count: "INTEGER", next_attempt_at: "TEXT", lease_until: "TEXT", last_error_code: "TEXT", sent_at: "TEXT" }
  };
  for (const [table, expected] of Object.entries(expectedTables)) {
    const actual = columnMap(db, table);
    if (actual.size !== Object.keys(expected).length || Object.entries(expected).some(([name, type]) => !actual.has(name) || String(actual.get(name).type).toUpperCase() !== type)) throw new Error(`Структура ${table} не соответствует схеме v10.`);
    if (!actual.get("id")?.pk) throw new Error(`В ${table} отсутствует первичный ключ.`);
  }
  const notNull = {
    meetings: ["title", "starts_at", "zoom_url", "created_by", "created_at"],
    meeting_broadcasts: ["meeting_id", "status", "scheduled_at", "timezone", "created_by", "created_at", "updated_at", "attempt_count"],
    meeting_deliveries: ["broadcast_id", "platform", "messenger_user_id", "status", "attempt_count"]
  };
  for (const [table, names] of Object.entries(notNull)) if (names.some((name) => !columnMap(db, table).get(name)?.notnull)) throw new Error(`Обязательные поля ${table} не соответствуют схеме v10.`);
  const expectedChecks = {
    meetings: ["length(trim(title))between1and200"],
    meeting_broadcasts: ["statusin('draft','scheduled','sending','completed','cancelled','failed')"],
    meeting_deliveries: ["platformin('telegram','max')", "statusin('pending','sending','sent','temporary_error','unavailable','uncertain')"]
  };
  for (const [table, expected] of Object.entries(expectedChecks)) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    if (JSON.stringify(checkExpressions(sql)) !== JSON.stringify(expected.sort())) throw new Error(`Ограничения состояний ${table} не соответствуют схеме v10.`);
  }
  const fk = (table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  const broadcastFks = fk("meeting_broadcasts");
  if (!broadcastFks.some((item) => item.table === "meetings" && item.from === "meeting_id" && item.to === "id" && item.on_delete.toUpperCase() === "CASCADE")) throw new Error("Рассылка не связана с встречей каскадным внешним ключом.");
  const deliveryFks = fk("meeting_deliveries");
  if (!deliveryFks.some((item) => item.table === "meeting_broadcasts" && item.from === "broadcast_id" && item.to === "id" && item.on_delete.toUpperCase() === "CASCADE") || !deliveryFks.some((item) => item.table === "participants" && item.from === "participant_id" && item.to === "id" && item.on_delete.toUpperCase() === "SET NULL")) throw new Error("Связи истории доставки не соответствуют схеме v10.");
  const checkIndex = (table, name, columns, unique, sql) => {
    const row = indexes(db, table).find((item) => item.name === name);
    const source = normalizeSql(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql);
    if (!row || Boolean(row.unique) !== unique || row.partial || JSON.stringify(row.columns) !== JSON.stringify(columns) || source !== sql) throw new Error(`Индекс ${name} не соответствует схеме v10.`);
  };
  checkIndex("meeting_broadcasts", "idx_meeting_broadcasts_due", ["status", "next_attempt_at", "scheduled_at"], false, "createindexidx_meeting_broadcasts_dueonmeeting_broadcasts(status,next_attempt_at,scheduled_at)");
  checkIndex("meeting_broadcasts", "idx_meeting_broadcasts_meeting", ["meeting_id", "status"], false, "createindexidx_meeting_broadcasts_meetingonmeeting_broadcasts(meeting_id,status)");
  checkIndex("meeting_deliveries", "idx_meeting_deliveries_due", ["broadcast_id", "status", "next_attempt_at"], false, "createindexidx_meeting_deliveries_dueonmeeting_deliveries(broadcast_id,status,next_attempt_at)");
  checkIndex("meeting_deliveries", "uq_meeting_deliveries_recipient", ["broadcast_id", "platform", "messenger_user_id"], true, "createuniqueindexuq_meeting_deliveries_recipientonmeeting_deliveries(broadcast_id,platform,messenger_user_id)");
  const broadcastUnique = indexes(db, "meeting_broadcasts").some((item) => item.unique && JSON.stringify(item.columns) === JSON.stringify(["meeting_id"]));
  if (!broadcastUnique) throw new Error("Для встречи допускается только одна рассылка.");
}
function migrateDatabase(db, { beforeVersionCommit, targetVersion = CURRENT_SCHEMA_VERSION } = {}) {
  if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion > CURRENT_SCHEMA_VERSION) throw new Error("Недопустимая целевая версия миграции.");
  const initial = inspectSchema(db);
  if (initial.version > targetVersion) throw new Error("Нельзя выполнить миграцию в обратную сторону.");
  if (initial.version === targetVersion) return { from: initial.version, to: targetVersion, applied: [] };
  const from = initial.version;
  const startingVersion = initial.legacyUnversioned ? initial.structuralVersion : from;
  if (startingVersion > targetVersion) throw new Error("Нельзя выполнить миграцию в обратную сторону.");
  if (initial.legacyUnversioned && startingVersion === targetVersion) {
    const stamp = db.transaction(() => {
      beforeVersionCommit?.(targetVersion, db);
      db.pragma(`user_version = ${targetVersion}`);
    });
    stamp.immediate();
    inspectSchema(db, { allowKnownOptionalColumns: false });
    return { from, detectedVersion: startingVersion, to: targetVersion, applied: [], stampedVersion: true };
  }
  const applied = [];
  for (let target = initial.empty ? 1 : startingVersion + 1; target <= targetVersion; target += 1) {
    const run = db.transaction(() => {
      if (target === 1 && initial.empty) createBaseSchema(db);
      if (target === 2 && !columnMap(db, "participants").has("consent_at")) db.exec("ALTER TABLE participants ADD COLUMN consent_at TEXT");
      if (target === 3 && !columnMap(db, "participants").has("consent_version")) db.exec("ALTER TABLE participants ADD COLUMN consent_version TEXT");
      if (target === 4 && !columnMap(db, "admins").has("username")) db.exec("ALTER TABLE admins ADD COLUMN username TEXT");
      if (target === 5) {
        if (!columnMap(db, "participants").has("consent_withdrawn_at")) db.exec("ALTER TABLE participants ADD COLUMN consent_withdrawn_at TEXT");
        if (!tableNames(db).includes("consent_withdrawal_requests")) db.exec(`CREATE TABLE consent_withdrawal_requests (
          id INTEGER PRIMARY KEY,
          participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          consent_at TEXT NOT NULL,
          requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','processed','not_applicable')),
          resolved_at TEXT,
          UNIQUE(participant_id, consent_at)
        )`);
      }
      if (target === 6) db.exec(`CREATE TABLE account_link_requests (
        request_id TEXT PRIMARY KEY NOT NULL,
        participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        target_platform TEXT NOT NULL CHECK(target_platform IN ('telegram','max')),
        target_account_id TEXT NOT NULL,
        target_verified_at TEXT NOT NULL,
        target_proof_method TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','consumed','rejected','cancelled','expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        participant_updated_at TEXT NOT NULL,
        decision_by_platform TEXT,
        decision_by_account_id TEXT,
        decision_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX idx_account_link_requests_participant ON account_link_requests(participant_id,state,created_at);
      CREATE UNIQUE INDEX uq_account_link_requests_target_active ON account_link_requests(target_platform,target_account_id) WHERE state IN ('pending','approved');
      CREATE TRIGGER trg_account_link_requests_state_transition BEFORE UPDATE OF state ON account_link_requests
      WHEN NOT (
        (OLD.state='pending' AND NEW.state IN ('approved','rejected','cancelled','expired')) OR
        (OLD.state='approved' AND NEW.state IN ('consumed','cancelled','expired'))
      ) AND OLD.state<>NEW.state
      BEGIN SELECT RAISE(ABORT,'invalid account link request state transition'); END;`);
      if (target === 7) db.exec(`CREATE TABLE participant_deletion_requests (
        id INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        participant_id INTEGER UNIQUE REFERENCES participants(id) ON DELETE SET NULL,
        requested_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','processed','not_applicable'))
      );
      CREATE INDEX idx_participant_deletion_requests_status ON participant_deletion_requests(status,requested_at);
      CREATE UNIQUE INDEX uq_participant_deletion_requests_active ON participant_deletion_requests(participant_id) WHERE status='pending_review';`);
      if (target === 8) db.exec(`
        CREATE TABLE participant_deletion_requests_v8 (
          id INTEGER PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
          requested_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','processed','not_applicable'))
        );
        INSERT INTO participant_deletion_requests_v8(id,request_id,participant_id,requested_at,status)
          SELECT id,request_id,participant_id,requested_at,status FROM participant_deletion_requests;
        DROP TABLE participant_deletion_requests;
        ALTER TABLE participant_deletion_requests_v8 RENAME TO participant_deletion_requests;
        CREATE INDEX idx_participant_deletion_requests_status ON participant_deletion_requests(status,requested_at);
        CREATE UNIQUE INDEX uq_participant_deletion_requests_active ON participant_deletion_requests(participant_id) WHERE status='pending_review';
      `);
      if (target === 9) db.exec(`
        CREATE TABLE demo_test_participants (
          participant_id INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_demo_test_participants_created_at ON demo_test_participants(created_at);
      `);
      if (target === 10) db.exec(`
        CREATE TABLE meetings (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
          starts_at TEXT NOT NULL,
          zoom_url TEXT NOT NULL,
          note TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE meeting_broadcasts (
          id INTEGER PRIMARY KEY,
          meeting_id INTEGER NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','completed','cancelled','failed')),
          scheduled_at TEXT NOT NULL,
          timezone TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          next_attempt_at TEXT,
          lease_owner TEXT,
          lease_until TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT
        );
        CREATE INDEX idx_meeting_broadcasts_due ON meeting_broadcasts(status,next_attempt_at,scheduled_at);
        CREATE INDEX idx_meeting_broadcasts_meeting ON meeting_broadcasts(meeting_id,status);
        CREATE TABLE meeting_deliveries (
          id INTEGER PRIMARY KEY,
          broadcast_id INTEGER NOT NULL REFERENCES meeting_broadcasts(id) ON DELETE CASCADE,
          participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
          platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),
          messenger_user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','temporary_error','unavailable','uncertain')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          lease_until TEXT,
          last_error_code TEXT,
          sent_at TEXT
        );
        CREATE INDEX idx_meeting_deliveries_due ON meeting_deliveries(broadcast_id,status,next_attempt_at);
        CREATE UNIQUE INDEX uq_meeting_deliveries_recipient ON meeting_deliveries(broadcast_id,platform,messenger_user_id);
        CREATE TABLE telegram_private_chats (
          telegram_id TEXT PRIMARY KEY,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX idx_telegram_private_chats_last_seen ON telegram_private_chats(last_seen_at);
      `);
      if (target === 11) db.exec(`
        CREATE TABLE meeting_send_rate_limit_state (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
          next_allowed_at TEXT,
          blocked_until TEXT,
          sender_token TEXT,
          sender_pid INTEGER,
          sender_host TEXT,
          sender_delivery_id INTEGER,
          sender_acquired_at TEXT
        );
        INSERT INTO meeting_send_rate_limit_state(singleton_id) VALUES(1);
      `);
      beforeVersionCommit?.(target, db);
      db.pragma(`user_version = ${target}`);
    });
    run.immediate();
    inspectSchema(db);
    applied.push({ version: target, label: migrationLabels.get(target) });
  }
  return { from, detectedVersion: startingVersion, to: targetVersion, applied, stampedVersion: initial.legacyUnversioned };
}

function previewMigrations(db) {
  const state = inspectSchema(db);
  const start = state.legacyUnversioned ? state.structuralVersion : state.version;
  const plan = Array.from({ length: CURRENT_SCHEMA_VERSION - start }, (_, i) => ({ version: start + i + 1, label: migrationLabels.get(start + i + 1), action: "apply" }));
  if (state.legacyUnversioned && start === CURRENT_SCHEMA_VERSION) plan.push({ version: CURRENT_SCHEMA_VERSION, label: "Зафиксировать версию уже существующей схемы", action: "set-user-version-only" });
  return {
    currentVersion: state.version,
    structuralVersion: state.structuralVersion,
    targetVersion: CURRENT_SCHEMA_VERSION,
    legacyUnversioned: state.legacyUnversioned,
    empty: state.empty,
    alreadyCurrent: state.version === CURRENT_SCHEMA_VERSION,
    plan
  };
}

function initializeEmptyDatabase(db) {
  const state = inspectSchema(db);
  if (state.empty) return migrateDatabase(db);
  if (state.version !== CURRENT_SCHEMA_VERSION) throw new Error(`База имеет схему версии ${state.version}; она не обновляется автоматически. Сначала проверьте миграцию командой npm.cmd run db:migrate -- --check --db "${db.name}".`);
  return { from: state.version, to: state.version, applied: [] };
}

module.exports = { CURRENT_SCHEMA_VERSION, CORE_TABLES, inspectSchema, migrateDatabase, previewMigrations, initializeEmptyDatabase, createBaseSchema };

