const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-admin-stats-"));
  process.env.DB_PATH = path.join(dir, "stats.sqlite");
  process.env.OWNER_TELEGRAM_ID = "90001";
  delete require.cache[require.resolve("../src/database")];
  delete require.cache[require.resolve("../src/admin")];
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
  async function send(text, id = 90001, type = "private") {
    const chatId = type === "private" ? id : -555;
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Test" }, text } });
    return sent.at(-1);
  }
  function add(data, daysAgo) {
    const participant = db.addParticipant({
      first_name: "ВымышленноеИмя",
      phone: `+7900555${String(db.getParticipantCount() + 1).padStart(4, "0")}`,
      ...data
    });
    const registeredAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.db.prepare("UPDATE participants SET registered_at=? WHERE id=?").run(registeredAt, participant.id);
    return participant;
  }
  return {
    db, bot, sent, send, add,
    close() {
      db.closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.DB_PATH;
      delete process.env.OWNER_TELEGRAM_ID;
      delete require.cache[require.resolve("../src/database")];
      delete require.cache[require.resolve("../src/admin")];
    }
  };
}

test("пустая база возвращает нули и категории «Не указано»", () => {
  const x = setup();
  try {
    const result = x.db.getParticipantStatistics();
    assert.equal(result.total, 0);
    assert.equal(result.last_7_days, 0);
    assert.equal(result.last_30_days, 0);
    assert.deepEqual(result.cities, [{ category: "Не указано", count: 0 }]);
  } finally { x.close(); }
});

test("статистика считает всего, регистрации за 7 и 30 дней и группирует поля", () => {
  const x = setup();
  try {
    x.add({ city: "Екатеринбург", referral_source: "Друзья", preferred_contact: "Telegram" }, 2);
    x.add({ city: "Екатеринбург", referral_source: "Telegram", preferred_contact: "Телефон" }, 14);
    x.add({ city: "Казань", referral_source: null, preferred_contact: null }, 45);
    const stats = x.db.getParticipantStatistics();
    assert.equal(stats.total, 3);
    assert.equal(stats.last_7_days, 1);
    assert.equal(stats.last_30_days, 2);
    assert.deepEqual(stats.cities, [{ category: "Екатеринбург", count: 2 }, { category: "Казань", count: 1 }]);
    assert.deepEqual(stats.referral_sources.map((row) => `${row.category}:${row.count}`).sort(), ["Друзья:1", "Не указано:1", "Telegram:1"].sort());
    assert.deepEqual(stats.preferred_contacts.map((row) => `${row.category}:${row.count}`).sort(), ["Не указано:1", "Телефон:1", "Telegram:1"].sort());
  } finally { x.close(); }
});

test("администратор видит статистику, обновление перечитывает базу, а обычный пользователь получает отказ", async () => {
  const x = setup();
  try {
    x.db.addAdmin("90002");
    x.add({ city: "Омск", referral_source: "Друзья", preferred_contact: "Telegram" }, 1);
    const initial = await x.send("📊 Статистика", 90002);
    assert.match(initial.text, /Всего участников: 1/);
    assert.match(initial.text, /Омск: 1/);
    assert.ok(initial.reply_markup.keyboard.flat().some((button) => button.text === "🔄 Обновить статистику"));
    x.add({ city: "Тула", referral_source: "Мероприятие", preferred_contact: "Email" }, 1);
    const refreshed = await x.send("🔄 Обновить статистику", 90002);
    assert.match(refreshed.text, /Всего участников: 2/);
    assert.match(refreshed.text, /Тула: 1/);
    assert.match((await x.send("📊 Статистика", 90003)).text, /нет доступа/);
    assert.match((await x.send("📊 Статистика", 90002, "group")).text, /только в личном чате/);
  } finally { x.close(); }
});

test("длинное распределение ограничивается десятью категориями и объединяет остаток", () => {
  const x = setup();
  try {
    for (let i = 0; i < 12; i++) x.add({ city: `Город${i}`, referral_source: `Источник${i}`, preferred_contact: `Способ${i}` }, 40);
    const stats = x.db.getParticipantStatistics();
    assert.equal(stats.cities.length, 11);
    assert.deepEqual(stats.cities.at(-1), { category: "Другие", count: 2 });
  } finally { x.close(); }
});

test("статистика безопасно сокращает длинные категории только для показа", async () => {
  const x=setup(); try {
    const city="Г".repeat(6000), source="И".repeat(6000);
    const participant=x.add({city,referral_source:source,preferred_contact:"Telegram"},1);
    const message=await x.send("📊 Статистика");
    assert.ok(message.text.length < 4096, `длина сообщения: ${message.text.length}`);
    assert.ok(message.text.includes(`${"Г".repeat(80)}: 1`));
    assert.ok(message.text.includes(`${"И".repeat(80)}: 1`));
    assert.equal(x.db.getParticipant(participant.id).city,city);
    assert.equal(x.db.getParticipant(participant.id).referral_source,source);
  } finally {x.close();}
});

