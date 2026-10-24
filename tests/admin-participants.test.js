const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-admin-participants-"));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = "10001";
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
  async function send(text, id = 10001, type = "private") {
    const chatId = type === "private" ? id : -555;
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Test" }, text } });
    return sent.at(-1);
  }
  function add(first_name, last_name, phone, city = null, registered_at = "2026-01-01T00:00:00.000Z") {
    const p = db.addParticipant({ first_name, last_name, phone, city, registered_at });
    // Set a deterministic registration date for stable list assertions.
    db.db.prepare("UPDATE participants SET registered_at=? WHERE id=?").run(registered_at, p.id);
    return p;
  }
  return { db, send, sent, add, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; delete process.env.OWNER_TELEGRAM_ID; delete require.cache[require.resolve("../src/database")]; delete require.cache[require.resolve("../src/admin")]; } };
}

test("поиск участников ищет имя, фамилию, частичные совпадения без регистра и полный телефон", () => {
  const x = setup();
  try {
    x.add("Анна", "Соколова", "+79001112233");
    x.add("Иван", "Смирнов", "+79004445566");
    assert.equal(x.db.searchParticipants("АННА")[0].first_name, "Анна");
    assert.equal(x.db.searchParticipants("сок")[0].last_name, "Соколова");
    assert.equal(x.db.searchParticipants("79001112233")[0].first_name, "Анна");
    assert.equal(x.db.searchParticipants("Ан").length, 2); // «Ан» есть в именах «Анна» и «Иван».
    assert.equal(x.db.searchParticipants("несуществующий").length, 0);
  } finally { x.close(); }
});

test("поиск показывает несколько совпадений и позволяет открыть полную анкету", async () => {
  const x = setup();
  try {
    x.add("Анна", "Соколова", "+79001112233");
    x.add("Анна", "Петрова", "+79004445566");
    await x.send("🔎 Найти участника");
    await x.send("Анна");
    assert.match(x.sent.at(-1).text, /Результаты поиска, страница 1/);
    assert.match(x.sent.at(-1).text, /Анна Петрова/);
    const selected = x.sent.at(-1).reply_markup.keyboard[0][0].text;
    await x.send(selected);
    assert.match(x.sent.at(-1).text, /Телефон: \+7900/);
    assert.match(x.sent.at(-1).text, /Предпочтительный способ связи:/);
  } finally { x.close(); }
});

test("поиск с большим числом совпадений разбит на страницы по десять и открывает выбранную анкету", async () => {
  const x = setup();
  try {
    for (let i = 1; i <= 23; i++) x.add(`МногоИмя${i}`, `Совпадение${i}`, `+7900000${String(i).padStart(4, "0")}`);
    await x.send("🔎 Найти участника");
    await x.send("МногоИмя");
    const first = x.sent.at(-1);
    assert.match(first.text, /Результаты поиска, страница 1/);
    assert.equal(first.reply_markup.keyboard.filter((row) => row[0].text.startsWith("👤 ")).length, 10);
    assert.ok(first.reply_markup.keyboard.some((row) => row.some((button) => button.text === "➡️ Далее")));
    assert.ok(first.text.length < 4096);

    await x.send("➡️ Далее");
    const second = x.sent.at(-1);
    assert.match(second.text, /страница 2/);
    assert.equal(second.reply_markup.keyboard.filter((row) => row[0].text.startsWith("👤 ")).length, 10);
    assert.ok(second.reply_markup.keyboard.some((row) => row.some((button) => button.text === "⬅️ Назад")));
    const selected = second.reply_markup.keyboard.find((row) => row[0].text.startsWith("👤 "))[0].text;
    await x.send(selected);
    assert.match(x.sent.at(-1).text, /Анкета участника/);
    assert.match(x.sent.at(-1).text, /Имя: МногоИмя/);

    await x.send("⬅️ К результатам");
    assert.match(x.sent.at(-1).text, /страница 2/);
    await x.send("➡️ Далее");
    assert.match(x.sent.at(-1).text, /страница 3/);
    assert.equal(x.sent.at(-1).reply_markup.keyboard.filter((row) => row[0].text.startsWith("👤 ")).length, 3);
    assert.equal(x.sent.at(-1).reply_markup.keyboard.some((row) => row.some((button) => button.text === "➡️ Далее")), false);
  } finally { x.close(); }
});

test("поиск обрезает чрезмерно длинные имена и фамилии до безопасной длины", async () => {
  const x = setup();
  try {
    x.add("ИмяДляПоиска" + "И".repeat(1000), "Ф".repeat(1000), "+79001112233");
    await x.send("🔎 Найти участника");
    await x.send("ИмяДляПоиска");
    const results = x.sent.at(-1);
    assert.ok(results.text.length < 4096);
    const nameButton = results.reply_markup.keyboard.find((row) => row[0].text.startsWith("👤 "))[0].text;
    assert.ok(nameButton.length <= 64);
    assert.ok(nameButton.length < 100);
    await x.send(nameButton);
    assert.ok(x.sent.at(-1).text.length < 4096);
    assert.ok(x.sent.at(-1).text.length < 2500);
  } finally { x.close(); }
});

test("при перелистывании поиска повторно проверяется действующая роль администратора", async () => {
  const x = setup();
  try {
    for (let i = 1; i <= 11; i++) x.add(`ОтзывИмя${i}`, `Фамилия${i}`, `+7900000${String(i).padStart(4, "0")}`);
    await x.send("🔎 Найти участника");
    await x.send("ОтзывИмя");
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run("10001");
    const denied = await x.send("➡️ Далее");
    assert.match(denied.text, /Доступ отозван/);
    assert.doesNotMatch(denied.text, /ОтзывИмя|Фамилия/);
  } finally { x.close(); }
});

test("список пустой базы сообщает об отсутствии участников", async () => {
  const x = setup();
  try { await x.send("👥 Все участники"); assert.match(x.sent.at(-1).text, /Пока нет зарегистрированных участников/); }
  finally { x.close(); }
});

test("список показывает по десять участников, листается и открывает анкету", async () => {
  const x = setup();
  try {
    for (let i = 1; i <= 11; i++) x.add(`Имя${i}`, `Фамилия${i}`, `+7900000${String(i).padStart(4, "0")}`, i === 11 ? "Город" : null, `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`);
    await x.send("👥 Все участники");
    assert.match(x.sent.at(-1).text, /страница 1/);
    assert.equal(x.sent.at(-1).reply_markup.keyboard.filter((row) => row[0].text.startsWith("👤 ")).length, 10);
    assert.match(x.sent.at(-1).text, /Город/);
    const firstButton = x.sent.at(-1).reply_markup.keyboard.find((row) => row[0].text.startsWith("👤 "))[0].text;
    await x.send(firstButton);
    assert.match(x.sent.at(-1).text, /Дата регистрации:/);
    await x.send("⬅️ К результатам");
    await x.send("➡️ Далее");
    assert.match(x.sent.at(-1).text, /страница 2/);
    assert.equal(x.sent.at(-1).reply_markup.keyboard.filter((row) => row[0].text.startsWith("👤 ")).length, 1);
  } finally { x.close(); }
});

test("неавторизованный пользователь и старые кнопки не открывают персональные данные", async () => {
  const x = setup();
  try {
    x.add("Скрытое", "Имя", "+79001112233");
    assert.match((await x.send("👥 Все участники", 30003)).text, /нет доступа/);
    assert.match((await x.send("🔎 Найти участника", 30003)).text, /нет доступа/);
    assert.match((await x.send("Отмена", 30003)).text, /нет доступа/);
    assert.match((await x.send("👥 Все участники", 30003, "group")).text, /только в личном чате/);
    assert.match((await x.send("👥 Все участники", 10001)).text, /страница 1/);
    // Снятие роли между экраном и действием блокирует устаревший экран.
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run("10001");
    assert.match((await x.send("⬅️ Назад", 10001)).text, /Доступ отозван/);
  } finally { x.close(); }
});

