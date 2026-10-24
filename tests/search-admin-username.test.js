const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Bot } = require("grammy");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-search-admin-"));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = "10001";
  for (const name of ["../src/database", "../src/admin"]) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require("../src/admin").registerAdmin(bot);
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method !== "sendMessage") throw new Error(`Unexpected API: ${method}`);
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text, id = 10001, username, command = false) {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id, type: "private" }, from: { id, is_bot: false, first_name: "Test", ...(username === undefined ? {} : { username }) }, ...(command ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}), text } });
    return sent.at(-1);
  }
  function add(first_name, last_name, phone) { return db.addParticipant({ first_name, last_name, phone }); }
  return { db, send, sent, add, dir, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; delete process.env.OWNER_TELEGRAM_ID; delete require.cache[require.resolve("../src/database")]; delete require.cache[require.resolve("../src/admin")]; } };
}

test("поиск считает русские е и ё равнозначными в обе стороны, без учёта регистра и с частичным совпадением", () => {
  const x = setup();
  try {
    x.add("Фёдор", "Семён", "+79001112233");
    x.add("Федор", "Соловьёв", "+79004445566");
    x.add("Алёна", "Петрова", "+79007778899");
    assert.ok(x.db.searchParticipants("Федор").some((p) => p.first_name === "Фёдор"));
    assert.ok(x.db.searchParticipants("Фёдор").some((p) => p.first_name === "Федор"));
    assert.equal(x.db.searchParticipants("семен").find((p) => p.first_name === "Фёдор").last_name, "Семён");
    assert.equal(x.db.searchParticipants("СЕМЁН").find((p) => p.first_name === "Фёдор").last_name, "Семён");
    assert.equal(x.db.searchParticipants("Алена")[0].first_name, "Алёна");
    assert.equal(x.db.searchParticipants("Соловьев")[0].last_name, "Соловьёв");
    x.add("Ирина", "ПЕТРОВА", "+79001234567");
    assert.equal(x.db.searchParticipants("петров").length, 2);
    assert.ok(x.db.searchParticipants("ПЕТРОВА").some((p) => p.last_name === "ПЕТРОВА"));
    assert.equal(x.db.searchParticipants("79001112233")[0].first_name, "Фёдор");
  } finally { x.close(); }
});

test("нормализация кириллической ё не смешивает её с латинской e", () => {
  const x = setup();
  try {
    x.add("Фёдор", "Иванов", "+79001112233");
    assert.equal(x.db.searchParticipants("Федор").length, 1);
    assert.equal(x.db.searchParticipants("Feдор").length, 0);
  } finally { x.close(); }
});

test("поиск по телефону и постраничный результат сохраняют прежнее поведение", () => {
  const x = setup();
  try {
    for (let i = 0; i < 23; i++) x.add(`Ёж${i}`, `Участник${i}`, `+7900000${String(i).padStart(4, "0")}`);
    assert.equal(x.db.searchParticipants("79000000000")[0].phone, "+79000000000");
    assert.equal(x.db.searchParticipants("ёж", 10, 0).length, 10);
    assert.equal(x.db.searchParticipants("еж", 10, 10).length, 10);
    assert.equal(x.db.searchParticipants("ёж", 10, 20).length, 3);
    assert.equal(x.db.searchParticipants("ёж", 10, 0)[0].id, x.db.searchParticipants("еж", 10, 0)[0].id);
  } finally { x.close(); }
});

test("список показывает username с @ и сообщает, когда username неизвестен", async () => {
  const x = setup();
  try {
    x.db.addAdmin("20002");
    await x.send("📋 Список администраторов", 10001, "club_owner");
    let text = x.sent.at(-1).text;
    assert.match(text, /👑 Владелец\nID: 10001\nTelegram: @club_owner/);
    assert.match(text, /🛡 Администратор\nID: 20002\nTelegram: Ник не указан/);
    assert.equal(x.db.getAdminRole("club_owner"), null);
    assert.match((await x.send("/admin", 30003, "club_owner", true)).text, /нет доступа/);
  } finally { x.close(); }
});

test("username обновляется при взаимодействии администратора и очищается, если его больше нет", async () => {
  const x = setup();
  try {
    await x.send("/admin", 10001, "old_owner", true);
    assert.equal(x.db.listAdmins()[0].username, "old_owner");
    await x.send("/admin", 10001, "new_owner", true);
    assert.equal(x.db.listAdmins()[0].username, "new_owner");
    await x.send("/admin", 10001, undefined, true);
    assert.equal(x.db.listAdmins()[0].username, null);
    await x.send("📋 Список администраторов", 10001);
    assert.match(x.sent.at(-1).text, /Telegram: Ник не указан/);
  } finally { x.close(); }
});

test("старая схема admins автоматически получает username без потери администраторов", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-legacy-admins-"));
  const file = path.join(dir, "legacy.sqlite");
  const modulePath = path.resolve(__dirname, "../src/database/index.js");
  const result = spawnSync(process.execPath, ["-e", `const Database=require('better-sqlite3');const db=new Database(process.env.DB_PATH);db.exec("CREATE TABLE admins (telegram_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin')), added_at TEXT NOT NULL DEFAULT 'legacy'); INSERT INTO admins(telegram_id,role) VALUES('10001','owner');");db.close();const d=require(process.env.MODULE_PATH);const columns=d.db.prepare('PRAGMA table_info(admins)').all();if(!columns.some(c=>c.name==='username'))process.exit(2);const row=d.listAdmins()[0];if(row.telegram_id!=='10001'||row.role!=='owner'||row.username!==null)process.exit(3);if(d.getAdminRole('10001')!=='owner'||d.getAdminRole('other')!==null)process.exit(4);d.closeDatabase();`], { env: { ...process.env, DB_PATH: file, MODULE_PATH: modulePath }, encoding: "utf8" });
  try { assert.equal(result.status, 0, result.stderr); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

