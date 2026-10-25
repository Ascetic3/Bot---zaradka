const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

const ownerId = 710001;
const userId = 710002;
const adminId = 710003;
const previewUrl = "https://preview.example.invalid/demo-policy.html";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-preview-"));
  const previousPreviewUrl = process.env.PREVIEW_POLICY_URL;
  process.env.DB_PATH = path.join(dir, "preview.sqlite");
  process.env.OWNER_TELEGRAM_ID = String(ownerId);
  process.env.PREVIEW_POLICY_URL = previewUrl;
  delete process.env.PRIVACY_POLICY_URL;
  const moduleNames = ["../src/database", "../src/registration", "../src/registration-preview", "../src/admin", "../src/profile"];
  for (const name of moduleNames) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  const bot = new Bot("123456:PREVIEW_TEST_TOKEN", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require("../src/admin").registerAdmin(bot);
  require("../src/registration-preview").registerRegistrationPreview(bot);
  require("../src/main-menu").registerStart(bot);
  require("../src/myid").registerMyId(bot);
  require("../src/registration").registerRegistration(bot);
  require("../src/profile").registerProfile(bot);
  const sent = [];
  const apiCalls = [];
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
    }
    if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") return { ok: true, result: true };
    throw new Error(`Unexpected Telegram method ${method}`);
  });
  let updateId = 0;
  async function send(text, id = ownerId, type = "private") {
    const chatId = type === "private" ? id : -711;
    const update = { update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Demo" }, text } };
    if (text.startsWith("/")) update.message.entities = [{ type: "bot_command", offset: 0, length: text.length }];
    await bot.handleUpdate(update);
    return sent.at(-1);
  }
  async function click(data, id = ownerId, type = "private") {
    const chatId = type === "private" ? id : -711;
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: `preview-callback-${updateId}`, from: { id, is_bot: false, first_name: "Demo" }, chat_instance: "preview",
      data, message: { message_id: 900 + updateId, date: 1, chat: { id: chatId, type }, from: { id: 123456, is_bot: true, first_name: "Test" }, text: "Демо" }
    } });
    return sent.at(-1);
  }
  async function startPreview() {
    const result = await send("/preview_registration");
    const accept = result.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    return accept ? click(accept) : result;
  }
  return { db, bot, sent, apiCalls, send, click, startPreview, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; delete process.env.OWNER_TELEGRAM_ID; delete process.env.PRIVACY_POLICY_URL; if (previousPreviewUrl === undefined) delete process.env.PREVIEW_POLICY_URL; else process.env.PREVIEW_POLICY_URL = previousPreviewUrl; } };
}

async function reachSummary(x) {
  const send = x.send;
  await x.startPreview();
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
    let reply = await x.startPreview();
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

test("preview начинает с HTML-экрана согласия с отдельной ссылкой и двумя inline-кнопками", async () => {
  const x = setup(); try {
    const before = Object.fromEntries(["participants", "accounts", "admins", "registration_drafts"].map((name) => [name, x.db.db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count]));
    const screen = await x.send("/preview_registration");
    assert.match(screen.text, /Демонстрационный экран согласия/);
    assert.equal(screen.parse_mode, "HTML");
    assert.ok(screen.text.includes(`<a href="${previewUrl}">политикой обработки персональных данных</a>`));
    assert.doesNotMatch(screen.text.replace(/<a href="[^"]+">/g, "<a>").replace(/<[^>]*>/g, ""), /https?:\/\//);
    assert.deepEqual(screen.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [["✅ Принимаю"], ["❌ Отказываюсь"]]);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.deepEqual(Object.fromEntries(["participants", "accounts", "admins", "registration_drafts"].map((name) => [name, x.db.db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count])), before);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});

test("принятие тестового экрана открывает первый вопрос, повторная и устаревшая кнопка безопасны", async () => {
  const x = setup(); try {
    const screen = await x.send("/preview_registration");
    const accept = screen.reply_markup.inline_keyboard[0][0].callback_data;
    const firstQuestion = await x.click(accept);
    assert.match(firstQuestion.text, /Как вас зовут/);
    assert.deepEqual(firstQuestion.reply_markup.keyboard.map((row) => row.map((button) => button.text)), [["❌ Отмена"]]);
    await x.click(accept);
    assert.match(x.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1).payload.text, /устарела|обработана/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("отказ завершает preview, возвращает главное меню и повторный отказ не меняет данные", async () => {
  const x = setup(); try {
    const screen = await x.send("/preview_registration");
    const decline = screen.reply_markup.inline_keyboard[1][0].callback_data;
    const menu = await x.click(decline);
    assert.match(menu.text, /Предварительный просмотр отменён/);
    assert.match(menu.text, /Добро пожаловать в клуб/);
    assert.ok(menu.reply_markup.keyboard.flat().some((button) => button.text === "Зарегистрироваться"));
    assert.match(JSON.stringify(x.apiCalls.filter((call) => call.method === "editMessageReplyMarkup").at(-1).payload), /"inline_keyboard":\[\]/);
    assert.match(JSON.stringify(x.apiCalls.filter((call) => call.method === "editMessageReplyMarkup").at(-1).payload), /"inline_keyboard":\[\]/);
    await x.click(decline);
    assert.match(x.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1).payload.text, /устарела|обработана/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("тестовое согласие нельзя принять из группы или от пользователя без роли владельца", async () => {
  const x = setup(); try {
    const screen = await x.send("/preview_registration");
    const accept = screen.reply_markup.inline_keyboard[0][0].callback_data;
    await x.click(accept, ownerId, "supergroup");
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.match(x.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1).payload.text, /только в личном чате/);
    await x.click(accept, userId);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

test("выход через /start завершает preview, а старая кнопка согласия становится недействительной", async () => {
  const x = setup(); try {
    const screen = await x.send("/preview_registration");
    const oldAccept = screen.reply_markup.inline_keyboard[0][0].callback_data;
    const menu = await x.send("/start");
    assert.match(menu.text, /Добро пожаловать в клуб/);
    assert.ok(menu.reply_markup.keyboard.flat().some((button) => button.text === "Зарегистрироваться"));
    await x.click(oldAccept);
    assert.match(x.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1).payload.text, /устарела|обработана/);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});

test("без PREVIEW_POLICY_URL бот объясняет настройку и не подставляет фиктивную ссылку", async () => {
  const x = setup(); try {
    delete process.env.PREVIEW_POLICY_URL;
    const reply = await x.send("/preview_registration");
    assert.match(reply.text, /PREVIEW_POLICY_URL/);
    assert.match(reply.text, /публичной HTTPS-странице/);
    assert.doesNotMatch(reply.text, /https?:\/\//);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});

test("preview принимает только HTTPS-ссылку и старая кнопка не проходит после смены ссылки", async () => {
  for (const url of ["http://policy.example.test/page", "not a url"]) {
    const x = setup(); try {
      process.env.PREVIEW_POLICY_URL = url;
      assert.match((await x.send("/preview_registration")).text, /PREVIEW_POLICY_URL/);
      assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    } finally { x.close(); }
  }
  const x = setup(); try {
    const screen = await x.send("/preview_registration");
    const oldAccept = screen.reply_markup.inline_keyboard[0][0].callback_data;
    process.env.PREVIEW_POLICY_URL = "https://new-preview.example.invalid/policy.html";
    await x.click(oldAccept);
    assert.match(x.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1).payload.text, /устарела|обработана/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("демонстрационная страница локальна и явно помечена как тестовая", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "demo-policy.html"), "utf8");
  assert.match(html, /Тестовая политика клуба „Магия утра“/);
  assert.match(html, /ДЕМОНСТРАЦИОННЫЙ ДОКУМЕНТ/);
  assert.match(html, /не является утверждённой политикой/);
});

test("обычный пользователь и владелец в группе не могут начать демонстрацию", async () => {
  const x = setup(); try {
    assert.match((await x.send("/preview_registration", userId)).text, /только владельцу или действующему администратору/);
    assert.match((await x.send("/preview_registration", ownerId, "group")).text, /только в личном чате/);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("действующий администратор может пройти экран политики и запустить preview", async () => {
  const x = setup(); try {
    x.db.addAdmin(String(adminId));
    const consent = await x.send("/preview_registration", adminId);
    assert.match(consent.text, /Демонстрационный экран согласия/);
    assert.deepEqual(consent.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [["✅ Принимаю"], ["❌ Отказываюсь"]]);
    const question = await x.click(consent.reply_markup.inline_keyboard[0][0].callback_data, adminId);
    assert.match(question.text, /Как вас зовут/);
    assert.equal(x.db.getDraft("telegram", adminId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("два администратора получают независимые preview-сессии", async () => {
  const x = setup(); try {
    const secondAdminId = 710004;
    x.db.addAdmin(String(adminId));
    x.db.addAdmin(String(secondAdminId));
    const firstScreen = await x.send("/preview_registration", adminId);
    const secondScreen = await x.send("/preview_registration", secondAdminId);
    const firstAccept = firstScreen.reply_markup.inline_keyboard[0][0].callback_data;
    const secondAccept = secondScreen.reply_markup.inline_keyboard[0][0].callback_data;
    assert.notEqual(firstAccept, secondAccept);
    await x.click(firstAccept, adminId);
    await x.send("Анна", adminId);
    const secondQuestion = await x.click(secondAccept, secondAdminId);
    assert.match(secondQuestion.text, /Как вас зовут/);
    const secondAnswer = await x.send("Борис", secondAdminId);
    assert.match(secondAnswer.text, /фамилию/);
    await x.send("Смирнова", adminId);
    assert.match(x.sent.at(-1).text, /Поделитесь номером телефона/);
    assert.equal(x.db.getDraft("telegram", adminId), undefined);
    assert.equal(x.db.getDraft("telegram", secondAdminId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("потеря admin-роли блокирует дальнейшие ответы и старые callback-кнопки", async () => {
  const x = setup(); try {
    x.db.addAdmin(String(adminId));
    const consent = await x.send("/preview_registration", adminId);
    const accept = consent.reply_markup.inline_keyboard[0][0].callback_data;
    await x.click(accept, adminId);
    x.db.removeAdmin(String(adminId));
    const deniedMessage = await x.send("Анна", adminId);
    assert.match(deniedMessage.text, /доступ.*отозван/i);
    assert.equal(x.db.getDraft("telegram", adminId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
    await x.click(accept, adminId);
    assert.match(x.apiCalls.filter((call) => call.method === "answerCallbackQuery").at(-1).payload.text, /доступ.*отозван/i);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("потеря роли владельца останавливает уже начатый предварительный просмотр", async () => {
  const x = setup(); try {
    await x.startPreview();
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run(String(ownerId));
    assert.match((await x.send("ДемоИмя")).text, /доступ.*отозван/i);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});
test("демонстрация поддерживает назад, сохранение ответов, пропуск и отмену без черновиков", async () => {
  const x = setup(); try {
    await x.startPreview(); await x.send("Анна"); await x.send("⬅️ Назад");
    assert.match(x.sent.at(-1).text, /Как вас зовут/);
    await x.send("Алиса"); await x.send("Смирнова"); await x.send("🧪 Использовать тестовый номер");
    await x.send("Пропустить");
    assert.match(x.sent.at(-1).text, /электронную почту/);
    await x.send("Пропустить"); await x.send("Telegram"); await x.send("Пропустить");
    assert.match(x.sent.at(-1).text, /Предварительный просмотр анкеты/);
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
    const cancelled = await x.send("❌ Отмена");
    assert.match(cancelled.text, /отменён/);
    assert.ok(cancelled.reply_markup.keyboard.flat().some((button) => button.text === "Зарегистрироваться"));
    assert.equal(x.db.getDraft("telegram", ownerId), undefined);
  } finally { x.close(); }
});

test("можно исправить отдельное поле и вернуться к итоговому просмотру", async () => {
  const x = setup(); try {
    await reachSummary(x);
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
    await x.startPreview();
    assert.match((await x.send("/start")).text, /Добро пожаловать/);
    assert.match((await x.send("/myid")).text, /Ваш Telegram ID/);
    assert.match((await x.send("/admin")).text, /Административное меню/);
    const consent = await x.send("/preview_registration");
    assert.match(consent.text, /Демонстрационный экран согласия/);
    const prompt = await x.click(consent.reply_markup.inline_keyboard[0][0].callback_data);
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
    await x.startPreview(); await x.send("Аня"); await x.send("Смирнова");
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
    await x.startPreview(); await x.send("Анна"); await x.send("Смирнова"); await x.send("🧪 Использовать тестовый номер");
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
    await x.startPreview(); await x.send("СтароеИмя");
    const cancelled=await x.send("❌ Отмена"); assert.match(cancelled.text,/отменён/);
    assert.equal(x.db.getParticipantCount(),0); assert.equal(x.db.getDraft("telegram",ownerId),undefined);
    const restarted=await x.startPreview(); assert.match(restarted.text,/Как вас зовут/);
    assert.match((await x.send("НовоеИмя")).text,/Введите вашу фамилию/);
  } finally { x.close(); }
});

test("Назад при выборе поля исправления возвращает к неизменённой сводке", async () => {
  const x=setup(); try {
    await reachSummary(x); await x.send("✏️ Исправить данные");
    const summary=await x.send("⬅️ Назад");
    assert.match(summary.text,/Предварительный просмотр анкеты/);
    assert.match(summary.text,/Имя: Анна/);
    assert.equal(x.db.getParticipantCount(),0);
  } finally { x.close(); }
});

