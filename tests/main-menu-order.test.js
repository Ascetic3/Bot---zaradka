const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");
const { createRateLimiter } = require("../src/request-limits");

const isolatedModules = [
  "../src/database", "../src/bot-handlers", "../src/admin", "../src/main-menu",
  "../src/myid", "../src/registration-preview", "../src/registration",
  "../src/profile", "../src/participant-service", "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu", "../src/meeting-broadcasts", "../src/meeting-broadcast-store", "../src/meeting-broadcast-service", "../src/private-chat-tracker"
];

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-menu-order-"));
  const originalEnv = Object.fromEntries(["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE"].map((key) => [key, process.env[key]]));
  process.env.DB_PATH = path.join(directory, "menu.sqlite");
  process.env.OWNER_TELEGRAM_ID = "70001";
  process.env.DEMO_MODE = "false";
  for (const key of isolatedModules) delete require.cache[require.resolve(key)];
  const database = require("../src/database");
  const { registerBotHandlers } = require("../src/bot-handlers");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const rateLimiter = createRateLimiter({ cleanupIntervalMs: 0 });
  const cleanups = registerBotHandlers(bot, { rateLimiter });
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
  });
  let updateId = 0;
  async function send(text, id = 70001) {
    updateId += 1;
    await bot.handleUpdate({ update_id: updateId, message: {
      message_id: updateId, date: 1, chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Synthetic" }, text
    } });
    return sent.slice(-1)[0] ?? null;
  }
  function close() {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    rateLimiter.stop();
    database.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const key of isolatedModules) delete require.cache[require.resolve(key)];
  }
  return { database, send, sent, close };
}

const keyboardTexts = (message) => message.payload.reply_markup?.keyboard?.flat().map((button) => button.text) ?? [];

test("обычный пользователь получает пользовательское меню через реальный порядок middleware, черновик анкеты сохранён", async () => {
  const x = setup();
  try {
    x.database.saveDraft("telegram", "70002", "first_name", { policy_url: "https://policy.invalid/test" });
    const menu = await x.send("🏠 Главное меню", 70002);
    assert.match(menu.payload.text, /Добро пожаловать в клуб/);
    assert.deepEqual(keyboardTexts(menu), ["Зарегистрироваться", "Моя анкета", "🔐 Мои данные", "🔗 Связанные аккаунты"]);
    assert.equal(x.database.getDraft("telegram", "70002").current_step, "first_name");
  } finally { x.close(); }
});

test("главное меню администратора завершает поиск и позволяет сразу открыть статистику и новый поиск", async () => {
  const x = setup();
  try {
    await x.send("/admin");
    await x.send("🔎 Найти участника");
    const menu = await x.send("🏠 Главное меню");
    assert.match(menu.payload.text, /Добро пожаловать в клуб/);
    assert.deepEqual(keyboardTexts(menu), ["Зарегистрироваться", "Моя анкета", "🔐 Мои данные", "🔗 Связанные аккаунты"]);

    const stats = await x.send("📊 Статистика");
    assert.match(stats.payload.text, /Статистика клуба/);
    await x.send("🔎 Найти участника");
    assert.match(x.sent.at(-1).payload.text, /Введите имя, фамилию/);
    assert.ok(keyboardTexts(x.sent.at(-1)).includes("Отмена"));
  } finally { x.close(); }
});

test("выход из операции добавления администратора сбрасывает состояние и не добавляет введённый позднее ID", async () => {
  const x = setup();
  try {
    await x.send("/admin");
    await x.send("⚙️ Управление администраторами");
    await x.send("➕ Добавить администратора");
    await x.send("🏠 Главное меню");
    await x.send("70003");
    assert.equal(x.database.getAdminRole("70003"), null);
    assert.match(x.sent.findLast((item) => item.payload.text?.includes("Добро пожаловать"))?.payload.text ?? "", /Добро пожаловать/);
  } finally { x.close(); }
});

test("главное меню завершает редактирование анкеты и возвращает правильную клавиатуру", async () => {
  const x = setup();
  try {
    const participant = x.database.addParticipant({ first_name: "ВымышленноеИмя", phone: "+79990000001" }, { platform: "telegram", messenger_user_id: "70001" });
    assert.ok(participant.id);
    await x.send("Моя анкета");
    await x.send("✏️ Изменить данные");
    assert.equal(x.database.getDraft("telegram", "70001").current_step, "profile_edit_select");
    const menu = await x.send("🏠 Главное меню");
    assert.match(menu.payload.text, /Добро пожаловать/);
    assert.deepEqual(keyboardTexts(menu), ["Зарегистрироваться", "Моя анкета", "🔐 Мои данные", "🔗 Связанные аккаунты"]);
    assert.equal(x.database.getDraft("telegram", "70001") ?? null, null);
  } finally { x.close(); }
});

