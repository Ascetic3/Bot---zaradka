const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-admin-cancel-"));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = "10001";
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  for (const name of ["database", "registration", "registration-preview", "admin", "profile"]) {
    const target = name === "database" ? "../src/database" : `../src/${name}`;
    delete require.cache[require.resolve(target)];
  }
  const db = require("../src/database");
  const bot = new Bot("123456:ADMIN_CANCEL_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const adminModule = require("../src/admin");
  adminModule.registerAdminUsernameRefresh(bot);
  require("../src/chat-guards").registerPrivateCallbackGuard(bot);
  adminModule.registerAdmin(bot);
  require("../src/registration-preview").registerRegistrationPreview(bot);
  require("../src/registration").registerRegistration(bot);
  require("../src/profile").registerProfile(bot);
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method !== "sendMessage") throw new Error(`Unexpected API method: ${method}`);
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text, id = 10001) {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id, type: "private" }, from: { id, is_bot: false, first_name: "Test" }, text } });
    return sent.at(-1);
  }
  async function callback(data, id = 10001) {
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: `callback-${updateId}`, from: { id, is_bot: false, first_name: "Test" }, chat_instance: "test-chat", data,
      message: { message_id: updateId, date: 1, chat: { id, type: "private" }, text: "Кнопка из устаревшего экрана" }
    } });
  }
  const buttons = (payload) => payload?.reply_markup?.keyboard?.flat().map((item) => item.text) ?? [];
  function addParticipant() { db.addParticipant({ first_name: "Тест", last_name: "Участник", phone: "+79001112233" }); }
  function beginSearch() { return send("🔎 Найти участника"); }
  function assertOwnerMenu(payload) {
    const labels = buttons(payload);
    assert.match(payload.text, /Административное меню/);
    for (const label of ["🔎 Найти участника", "👥 Все участники", "📊 Статистика", "📥 Скачать Excel", "⚙️ Управление администраторами", "🏠 Главное меню"]) assert.ok(labels.includes(label), `В меню отсутствует кнопка ${label}`);
    assert.equal(labels.includes("Отмена"), false);
  }
  return { db, sent, send, callback, buttons, addParticipant, beginSearch, assertOwnerMenu, close() {
    try { db.closeDatabase(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of ["DB_PATH", "OWNER_TELEGRAM_ID", "PRIVACY_POLICY_URL"]) delete process.env[name];
    for (const name of ["database", "registration", "registration-preview", "admin", "profile"]) {
      const target = name === "database" ? "../src/database" : `../src/${name}`;
      delete require.cache[require.resolve(target)];
    }
  } };
}

test("поиск показывает кнопку отмены", async () => {
  const x = setup();
  try {
    const prompt = await x.beginSearch();
    assert.match(prompt.text, /Введите имя, фамилию или полный номер телефона/);
    assert.deepEqual(x.buttons(prompt), ["Отмена"]);
  } finally { x.close(); }
});

test("отмена поиска без запроса возвращает административное меню и заменяет клавиатуру", async () => {
  const x = setup();
  try {
    await x.beginSearch();
    const before = x.db.getParticipantCount();
    const response = await x.send("Отмена");
    x.assertOwnerMenu(response);
    assert.equal(x.db.getParticipantCount(), before);
  } finally { x.close(); }
});

test("сообщение Отмена проходит через активный черновик регистрации и сохраняет его", async () => {
  const x = setup();
  try {
    x.db.saveDraft("telegram", "10001", "first_name", { consent_at: "2026-01-01T00:00:00.000Z" });
    await x.beginSearch();
    const response = await x.send("Отмена");
    x.assertOwnerMenu(response);
    assert.equal(x.db.getDraft("telegram", "10001").current_step, "first_name");
  } finally { x.close(); }
});

test("отмена после пяти найденных участников возвращает меню и снимает reply-клавиатуру поиска", async () => {
  const x = setup();
  try {
    for (let i = 1; i <= 5; i++) x.db.addParticipant({ first_name: "Федор", last_name: `Участник${i}`, phone: `+7900000000${i}` });
    await x.beginSearch();
    const results = await x.send("Федор");
    assert.match(results.text, /Результаты поиска, страница 1/);
    assert.equal(x.buttons(results).filter((label) => label.startsWith("👤 ")).length, 5);
    assert.ok(x.buttons(results).includes("Отмена"));
    const response = await x.send("Отмена");
    x.assertOwnerMenu(response);
  } finally { x.close(); }
});

test("отмена после пустого результата работает", async () => {
  const x = setup();
  try {
    await x.beginSearch();
    const empty = await x.send("Неизвестный участник");
    assert.match(empty.text, /Ничего не найдено/);
    assert.deepEqual(x.buttons(empty), ["Отмена"]);
    x.assertOwnerMenu(await x.send("Отмена"));
  } finally { x.close(); }
});

test("отмена после перелистывания на вторую страницу закрывает поиск", async () => {
  const x = setup();
  try {
    for (let i = 1; i <= 12; i++) x.db.addParticipant({ first_name: "Страница", last_name: `Участник${i}`, phone: `+790000000${String(i).padStart(2, "0")}` });
    await x.beginSearch();
    await x.send("Страница");
    assert.ok(x.buttons(x.sent.at(-1)).includes("➡️ Далее"));
    const secondPage = await x.send("➡️ Далее");
    assert.match(secondPage.text, /страница 2/);
    x.assertOwnerMenu(await x.send("Отмена"));
  } finally { x.close(); }
});

test("отмена после открытия найденного участника закрывает карточку и поиск", async () => {
  const x = setup();
  try {
    x.addParticipant();
    await x.beginSearch();
    const results = await x.send("Тест");
    const participantButton = x.buttons(results).find((label) => label.startsWith("👤 "));
    const details = await x.send(participantButton);
    assert.match(details.text, /Анкета участника/);
    assert.deepEqual(x.buttons(details), ["⬅️ К результатам", "🏠 Админ-меню"]);
    x.assertOwnerMenu(await x.send("Отмена"));
  } finally { x.close(); }
});

test("callback со старого экрана после отмены не возобновляет поиск и не показывает анкету", async () => {
  const x = setup();
  try {
    x.addParticipant();
    await x.beginSearch();
    const results = await x.send("Тест");
    assert.match(results.text, /Результаты поиска/);
    x.assertOwnerMenu(await x.send("Отмена"));
    const sentCount = x.sent.length;
    await x.callback("admin:search:open:1");
    assert.equal(x.sent.length, sentCount);
    assert.doesNotMatch(x.sent.at(-1).text, /Анкета участника/);
  } finally { x.close(); }
});

test("повторное нажатие отмены безопасно и не возвращает клавиатуру поиска", async () => {
  const x = setup();
  try {
    await x.beginSearch();
    x.assertOwnerMenu(await x.send("Отмена"));
    const count = x.sent.length;
    await x.send("Отмена");
    assert.equal(x.sent.length, count);
    assert.equal(x.buttons(x.sent.at(-1)).includes("Отмена"), false);
  } finally { x.close(); }
});

test("после отмены можно начать новый поиск", async () => {
  const x = setup();
  try {
    await x.beginSearch();
    await x.send("Отмена");
    const prompt = await x.beginSearch();
    assert.deepEqual(x.buttons(prompt), ["Отмена"]);
  } finally { x.close(); }
});

test("после отмены поиска можно открыть статистику", async () => {
  const x = setup();
  try {
    await x.beginSearch();
    await x.send("Отмена");
    const response = await x.send("📊 Статистика");
    assert.match(response.text, /Статистика клуба/);
    assert.deepEqual(x.buttons(response), ["🔄 Обновить статистику", "⬅️ Админ-меню"]);
  } finally { x.close(); }
});

test("после отмены поиска можно открыть список участников", async () => {
  const x = setup();
  try {
    x.addParticipant();
    await x.beginSearch();
    await x.send("Отмена");
    const response = await x.send("👥 Все участники");
    assert.match(response.text, /Участники, страница 1/);
    assert.ok(x.buttons(response).some((label) => label.startsWith("👤 ")));
  } finally { x.close(); }
});

test("отмена после показа результатов завершает поиск и скрывает результаты из клавиатуры", async () => {
  const x = setup();
  try {
    x.addParticipant();
    await x.beginSearch();
    await x.send("Тест");
    assert.match(x.sent.at(-1).text, /Результаты поиска/);
    const menu = await x.send("Отмена");
    x.assertOwnerMenu(menu);
    assert.equal(x.buttons(menu).some((label) => label.startsWith("👤 ")), false);
  } finally { x.close(); }
});

test("состояние поиска изолировано для каждого администратора", async () => {
  const x = setup();
  try {
    x.db.addAdmin("20002");
    await x.beginSearch();
    const sentBefore = x.sent.length;
    await x.send("Отмена", 20002);
    assert.equal(x.sent.length, sentBefore);
    assert.match((await x.send("Отмена", 10001)).text, /Административное меню/);
  } finally { x.close(); }
});

test("отмена во время поиска всё равно проверяет действующие права", async () => {
  const x = setup();
  try {
    await x.beginSearch();
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run("10001");
    const response = await x.send("Отмена");
    assert.match(response.text, /Доступ отозван/);
    assert.equal(response.reply_markup, undefined);
  } finally { x.close(); }
});

test("переключение с поиска на добавление и отмена очищают предыдущее состояние", async () => {
  const x = setup(); try {
    x.addParticipant();
    await x.beginSearch();
    assert.ok(x.buttons(x.sent.at(-1)).includes("Отмена"));
    assert.match((await x.send("➕ Добавить администратора")).text, /Telegram ID нового администратора/);
    assert.match((await x.send("Отмена")).text, /Действие отменено/);
    assert.ok(x.buttons(x.sent.at(-1)).includes("📋 Список администраторов"));
    assert.equal(x.buttons(x.sent.at(-1)).includes("Отмена"), false);
    const priorCount = x.sent.length;
    await x.send("не-числовой-старый-запрос");
    assert.equal(x.sent.length, priorCount);
    assert.equal(x.db.getAdminRole("не-числовой-старый-запрос"), null);
    assert.equal(x.db.getParticipantCount(), 1);
  } finally { x.close(); }
});

test("после переключения поиск очищается, а старый запрос не попадает в новую операцию", async () => {
  const x = setup(); try {
    x.addParticipant();
    await x.beginSearch();
    await x.send("➕ Добавить администратора");
    const response = await x.send("10002");
    assert.match(response.text, /добавлен/i);
    assert.equal(x.db.getAdminRole("10002"), "admin");
    const previous = x.sent.length;
    await x.send("Федор");
    assert.equal(x.sent.length, previous);
    assert.equal(x.db.getParticipantCount(), 1);
  } finally { x.close(); }
});

test("после отзыва роли незавершённый поиск очищается и не показывает результат", async () => {
  const x = setup(); try {
    x.db.addAdmin("10002");
    x.addParticipant();
    await x.send("🔎 Найти участника", "10002");
    x.db.removeAdmin("10002");
    const response = await x.send("Федор", "10002");
    assert.match(response.text, /доступ отозван|нет доступа/i);
    assert.equal(x.db.getParticipantCount(), 1);
  } finally { x.close(); }
});

test("состояния двух администраторов независимы", async () => {
  const x = setup(); try {
    x.db.addAdmin("10002");
    x.addParticipant();
    await x.beginSearch();
    await x.send("🔎 Найти участника", "10002");
    assert.match((await x.send("Тест")).text, /Результаты поиска/);
    assert.match((await x.send("Отмена", "10002")).text, /Административное меню/);
    const ownerSelection = x.buttons(x.sent[2]).find((button) => button.startsWith("👤 "));
    assert.ok(ownerSelection);
    assert.match((await x.send(ownerSelection)).text, /Анкета участника/);
    assert.equal(x.db.getParticipantCount(), 1);
    assert.equal(x.db.getAdminRole("10002"), "admin");
  } finally { x.close(); }
});

test("отмена добавления администратора возвращает меню управления", async () => {
  const x = setup();
  try {
    await x.send("⚙️ Управление администраторами");
    await x.send("➕ Добавить администратора");
    const response = await x.send("Отмена");
    assert.match(response.text, /Действие отменено/);
    assert.deepEqual(x.buttons(response), ["📋 Список администраторов", "➕ Добавить администратора", "➖ Удалить администратора", "⬅️ В меню администратора"]);
    assert.equal(x.db.getAdminRole("20002"), null);
  } finally { x.close(); }
});

test("отмена удаления администратора возвращает меню управления без удаления записей", async () => {
  const x = setup();
  try {
    x.db.addAdmin("20002");
    await x.send("⚙️ Управление администраторами");
    await x.send("➖ Удалить администратора");
    const response = await x.send("Отмена");
    assert.match(response.text, /Действие отменено/);
    assert.deepEqual(x.buttons(response), ["📋 Список администраторов", "➕ Добавить администратора", "➖ Удалить администратора", "⬅️ В меню администратора"]);
    assert.equal(x.db.getAdminRole("20002"), "admin");
  } finally { x.close(); }
});

test("отмена выгрузки Excel возвращает подходящее меню администратора", async () => {
  const x = setup();
  try {
    x.addParticipant();
    await x.send("📥 Скачать Excel");
    assert.ok(x.buttons(x.sent.at(-1)).includes("✅ Подтвердить выгрузку"));
    const response = await x.send("Отмена");
    assert.match(response.text, /Выгрузка отменена/);
    for (const label of ["🔎 Найти участника", "👥 Все участники", "📊 Статистика", "📥 Скачать Excel", "⚙️ Управление администраторами", "🏠 Главное меню"]) assert.ok(x.buttons(response).includes(label));
    assert.equal(x.buttons(response).includes("Отмена"), false);
  } finally { x.close(); }
});
