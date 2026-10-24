const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

const ownerId = 710001;
const userId = 710002;
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-preview-"));
  process.env.DB_PATH = path.join(dir, "preview.sqlite");
  process.env.OWNER_TELEGRAM_ID = String(ownerId);
  delete process.env.PRIVACY_POLICY_URL;
  const moduleNames = ["../src/database", "../src/registration", "../src/registration-preview", "../src/admin", "../src/profile"];
  for (const name of moduleNames) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  const bot = new Bot("123456:PREVIEW_TEST_TOKEN", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require("../src/main-menu").registerStart(bot);
  require("../src/myid").registerMyId(bot);
  require("../src/admin").registerAdmin(bot);
  require("../src/registration-preview").registerRegistrationPreview(bot);
  require("../src/registration").registerRegistration(bot);
  require("../src/profile").registerProfile(bot);
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method !== "sendMessage") throw new Error(`Unexpected Telegram method ${method}`);
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text, id = ownerId, type = "private") {
    const chatId = type === "private" ? id : -711;
    const update = { update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Demo" }, text } };
    if (text.startsWith("/")) update.message.entities = [{ type: "bot_command", offset: 0, length: text.length }];
    await bot.handleUpdate(update);
    return sent.at(-1);
  }
  return { db, bot, sent, send, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; delete process.env.OWNER_TELEGRAM_ID; delete process.env.PRIVACY_POLICY_URL; } };
}

async function reachSummary(send) {
  await send("/preview_registration");
  await send("Анна");
  await send("Смирнова");
  await send("🧪 Использовать тестовый номер");
  await send("Пропустить");
  await send("anna@example.invalid");
  await send("Электронная почта");
  await send("Другое");
  return send("На встрече клуба");
}

test("владелец запускает демонстрацию без политики и проходит все вопросы без записей в БД", async () => {
  const x = setup(); try {
    const beforeAdmins = x.db.listAdmins();
    x.db.saveDraft("telegram", ownerId, "city", { first_name: "Существующее имя" });
    const beforeDraft = x.db.getDraft("telegram", ownerId);
    const tableCounts = () => Object.fromEntries(["participants", "accounts", "admins", "registration_drafts"].map((table) => [table, x.db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    const beforeCounts = tableCounts();
    let reply = await x.send("/preview_registration");
    assert.match(reply.text, /Как вас зовут/);
    reply = await x.send("Анна"); assert.match(reply.text, /фамилию/);
    reply = await x.send("Смирнова"); assert.match(reply.text, /Поделитесь номером телефона/);
    reply = await x.send("🧪 Использовать тестовый номер"); assert.match(reply.text, /В каком городе/);
    reply = await x.send("Пропустить"); assert.match(reply.text, /электронную почту/);
    reply = await x.send("anna@example.invalid"); assert.match(reply.text, /Как с вами удобнее всего связаться/);
    reply = await x.send("Электронная почта"); assert.match(reply.text, /Откуда вы узнали/);
    reply = await x.send("Другое"); assert.match(reply.text, /свой вариант/);
    reply = await x.send("На встрече клуба");
    assert.match(reply.text, /Анна/); assert.match(reply.text, /Смирнова/); assert.match(reply.text, /\+70000000000/);
    assert.match(reply.text, /Это предварительный просмотр\. Анкета не будет сохранена/);
    assert.equal(x.db.getParticipantCount(), 0); assert.equal(x.db.listAdmins().length, beforeAdmins.length);
    assert.equal(x.db.getDraft("telegram", ownerId).current_step, "city");
    assert.equal(x.db.getDraft("telegram", ownerId).answers.first_name, "Существующее имя");
    assert.deepEqual(x.db.getDraft("telegram", ownerId), beforeDraft);
    assert.deepEqual(x.db.listAdmins(), beforeAdmins);
    assert.deepEqual(tableCounts(), beforeCounts);
    assert.match((await x.send("✅ Подтвердить регистрацию")).text, /Демонстрация успешно завершена\. Регистрация не выполнена/);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getDraft("telegram", ownerId).current_step, "city");
    assert.deepEqual(x.db.getDraft("telegram", ownerId), beforeDraft);
    assert.deepEqual(tableCounts(), beforeCounts);
  } finally { x.close(); }
});

test("обычный пользователь и владелец в группе не могут начать демонстрацию", async () => {
  const x = setup(); try {
    assert.match((await x.send("/preview_registration", userId)).text, /только владельцу/);
    assert.match((await x.send("/preview_registration", ownerId, "group")).text, /только в личном чате/);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("потеря роли владельца останавливает уже начатый предварительный просмотр", async () => {
  const x = setup(); try {
    await x.send("/preview_registration");
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run(String(ownerId));
    assert.match((await x.send("ДемоИмя")).text, /доступ.*отозван/i);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});
test("демонстрация поддерживает назад, сохранение ответов, пропуск и отмену без черновиков", async () => {
  const x = setup(); try {
    await x.send("/preview_registration"); await x.send("Анна"); await x.send("⬅️ Назад");
    assert.match(x.sent.at(-1).text, /Как вас зовут/);
    await x.send("Алиса"); await x.send("Смирнова"); await x.send("🧪 Использовать тестовый номер");
    await x.send("Пропустить");
    assert.match(x.sent.at(-1).text, /электронную почту/);
    await x.send("Пропустить"); await x.send("Telegram"); await x.send("Пропустить");
    assert.match(x.sent.at(-1).text, /Предварительный просмотр анкеты/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.match((await x.send("❌ Отмена")).text, /отменён/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});

test("можно исправить отдельное поле и вернуться к итоговому просмотру", async () => {
  const x = setup(); try {
    await reachSummary(x.send);
    assert.match((await x.send("✏️ Исправить данные")).text, /Какое поле исправить/);
    assert.match((await x.send("Имя")).text, /Как вас зовут/);
    const summary = await x.send("Мария");
    assert.match(summary.text, /Имя: Мария/);
    assert.match(summary.text, /Анкета не будет сохранена/);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("команды start, myid и admin не становятся ответами демонстрационной анкеты", async () => {
  const x = setup(); try {
    await x.send("/preview_registration");
    assert.match((await x.send("/start")).text, /Добро пожаловать/);
    assert.match((await x.send("/myid")).text, /Ваш Telegram ID/);
    assert.match((await x.send("/admin")).text, /Административное меню/);
    const prompt = await x.send("/preview_registration");
    assert.match(prompt.text, /Как вас зовут/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("настоящая регистрация всё ещё требует PRIVACY_POLICY_URL", async () => {
  const x = setup(); try {
    assert.match((await x.send("Зарегистрироваться")).text, /PRIVACY_POLICY_URL/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});

test("кнопка Назад на шаге тестового телефона возвращает к фамилии", async () => {
  const x=setup(); try {
    await x.send("/preview_registration"); await x.send("Аня"); await x.send("Смирнова");
    const back=await x.send("⬅️ Назад");
    assert.match(back.text,/фамилию/i);
    assert.ok(back.reply_markup.keyboard.flat().some((button) => button.text === "⬅️ Назад"));
    assert.match((await x.send("НоваяФамилия")).text,/Поделитесь номером телефона/);
    const phone=await x.send("🧪 Использовать тестовый номер");
    assert.match(phone.text,/В каком городе/);
    assert.match((await x.send("Пропустить")).text,/электронную почту/);
  } finally { x.close(); }
});

test("Назад из своего варианта снимает флаг ожидания и позволяет выбрать источник повторно", async () => {
  const x=setup(); try {
    await x.send("/preview_registration"); await x.send("Анна"); await x.send("Смирнова"); await x.send("🧪 Использовать тестовый номер");
    await x.send("Пропустить"); await x.send("Пропустить"); await x.send("Telegram"); await x.send("Другое");
    const choices=await x.send("⬅️ Назад");
    assert.match(choices.text,/Откуда вы узнали/);
    assert.ok(choices.reply_markup.keyboard.flat().some((button) => button.text === "Другое"));
    const summary=await x.send("Пропустить");
    assert.match(summary.text,/Откуда узнали о клубе: Не указано/);
    assert.match(summary.text,/Это предварительный просмотр\. Анкета не будет сохранена/);
  } finally { x.close(); }
});

test("в предварительном просмотре можно отменить и запустить анкету заново", async () => {
  const x=setup(); try {
    await x.send("/preview_registration"); await x.send("СтароеИмя");
    const cancelled=await x.send("❌ Отмена"); assert.match(cancelled.text,/отменён/);
    assert.equal(x.db.getParticipantCount(),0); assert.equal(x.db.getDraft("telegram",ownerId),undefined);
    const restarted=await x.send("/preview_registration"); assert.match(restarted.text,/Как вас зовут/);
    assert.match((await x.send("НовоеИмя")).text,/Введите вашу фамилию/);
  } finally { x.close(); }
});

test("Назад при выборе поля исправления возвращает к неизменённой сводке", async () => {
  const x=setup(); try {
    await reachSummary(x.send); await x.send("✏️ Исправить данные");
    const summary=await x.send("⬅️ Назад");
    assert.match(summary.text,/Предварительный просмотр анкеты/);
    assert.match(summary.text,/Имя: Анна/);
    assert.equal(x.db.getParticipantCount(),0);
  } finally { x.close(); }
});
