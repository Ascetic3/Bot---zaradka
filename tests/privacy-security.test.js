const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot, GrammyError } = require("grammy");

const userId = 77331001;

function setup({ failSendMessage = false, policy = "https://policy.invalid/test" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-privacy-"));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.PRIVACY_POLICY_URL = policy;
  process.env.OWNER_TELEGRAM_ID = String(userId);
  for (const modulePath of ["../src/database", "../src/participant-service", "../src/registration", "../src/profile", "../src/chat-guards", "../src/error-handler", "../src/main-menu", "../src/admin", "../src/myid"]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const db = require("../src/database");
  const bot = new Bot("123456:PRIVACY_TEST_ONLY", {
    botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" }
  });
  const { registerPrivateCallbackGuard } = require("../src/chat-guards");
  registerPrivateCallbackGuard(bot);
  require("../src/main-menu").registerStart(bot);
  require("../src/myid").registerMyId(bot);
  require("../src/registration").registerRegistration(bot);
  require("../src/admin").registerAdmin(bot);
  require("../src/profile").registerProfile(bot);
  bot.catch(require("../src/error-handler").handleBotError);

  const requests = [];
  let updateId = 0;
  bot.api.config.use(async (_previous, method, payload) => {
    requests.push({ method, payload });
    if (failSendMessage && method === "sendMessage") {
      throw new GrammyError("API request failed: simulated PII-bearing response", {
        ok: false,
        error_code: 500,
        description: "simulated failure"
      }, method, payload);
    }
    if (method === "answerCallbackQuery") return { ok: true, result: true };
    return { ok: true, result: {
      message_id: requests.length,
      date: 1,
      chat: { id: payload.chat_id, type: "private" },
      text: payload.text || ""
    } };
  });

  async function send(text, { chatType = "private", senderId = userId, contact } = {}) {
    const message = {
      message_id: ++updateId,
      date: 1,
      chat: { id: chatType === "private" ? senderId : -10077331, type: chatType },
      from: { id: senderId, is_bot: false, first_name: "Тест" }
    };
    if (text !== undefined) message.text = text;
    if (text?.startsWith("/")) message.entities = [{ type: "bot_command", offset: 0, length: text.indexOf(" ") > 0 ? text.indexOf(" ") : text.length }];
    if (contact) message.contact = contact;
    await bot.handleUpdate({ update_id: updateId, message });
    return requests.at(-1);
  }

  function close() {
    try { db.closeDatabase(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.PRIVACY_POLICY_URL;
    delete process.env.OWNER_TELEGRAM_ID;
  }
  return { bot, db, requests, send, close };
}

function addDraft(db, step = "first_name") {
  db.saveDraft("telegram", userId, step, { policy_url: "https://policy.invalid/test" });
}

function addParticipant(db) {
  return db.addParticipant({
    first_name: "КонфиденциальноеИмя",
    last_name: "ТестоваяФамилия",
    phone: "+79991234567",
    email: "private-marker@example.invalid",
    city: "Секретоград",
    preferred_contact: "Telegram",
    referral_source: "Тест",
    phone_confirmed_at: new Date().toISOString(),
    personal_data_consent: true
  }, { platform: "telegram", messenger_user_id: userId });
}

test("нажатие «Зарегистрироваться» в группе и супергруппе блокируется до проверки политики", async () => {
  const x = setup({ policy: "" });
  try {
    x.db.findParticipantByTelegramId = () => { throw new Error("В группе нельзя читать анкету"); };
    for (const chatType of ["group", "supergroup"]) {
      await x.send("Зарегистрироваться", { chatType });
      assert.equal(x.requests.at(-1).payload.text, "🔒 Регистрация доступна только в личном чате.\n\nОткройте @magia_utra_club_bot, чтобы зарегистрироваться.");
      assert.doesNotMatch(x.requests.at(-1).payload.text, /PRIVACY_POLICY_URL/);
      assert.equal(x.db.getDraft("telegram", userId), undefined);
    }
  } finally { x.close(); }
});

test("/start в группе и супергруппе показывает приглашение без клавиатуры, а в личном чате меню сохраняется", async () => {
  const x = setup();
  try {
    for (const chatType of ["group", "supergroup"]) {
      await x.send("/start", { chatType });
      const payload = x.requests.at(-1).payload;
      assert.equal(payload.text, "☀️ Добро пожаловать в клуб „Магия утра“!\n\nРегистрация и работа с анкетой доступны только в личных сообщениях с ботом.\n\nПерейдите к @magia_utra_club_bot.");
      assert.equal(payload.reply_markup, undefined);
    }
    await x.send("/start");
    assert.match(x.requests.at(-1).payload.text, /Выберите действие/);
    assert.equal(x.requests.at(-1).payload.reply_markup.keyboard[0][0].text, "Зарегистрироваться");
  } finally { x.close(); }
});

test("групповое сообщение не продолжает сохранённую регистрацию и не меняет черновик", async () => {
  const x = setup();
  try {
    for (const chatType of ["group", "supergroup"]) {
      addDraft(x.db);
      await x.send("ЛичноеИмя", { chatType });
      assert.match(x.requests.at(-1).payload.text, /только в личном чате/i);
      assert.equal(x.db.getDraft("telegram", userId).current_step, "first_name");
    }
    assert.equal(x.db.getDraft("telegram", userId).answers.first_name, undefined);
  } finally { x.close(); }
});

test("контакт из группы или супергруппы не принимается как подтверждение телефона", async () => {
  const x = setup();
  try {
    for (const chatType of ["group", "supergroup"]) {
      addDraft(x.db, "phone");
      await x.send(undefined, { chatType, contact: { phone_number: "+79990001122", user_id: userId } });
      assert.match(x.requests.at(-1).payload.text, /только в личном чате/i);
      assert.equal(x.db.getDraft("telegram", userId).answers.phone, undefined);
    }
    assert.equal(x.db.getDraft("telegram", userId).answers.phone, undefined);
  } finally { x.close(); }
});

test("/admin и /myid остаются недоступны в группах и супергруппах даже владельцу", async () => {
  const x = setup();
  try {
    for (const chatType of ["group", "supergroup"]) {
      await x.send("/admin", { chatType, senderId: userId });
      assert.match(x.requests.at(-1).payload.text, /только в личном чате/);
      assert.equal(x.requests.at(-1).payload.reply_markup, undefined);
      await x.send("/myid", { chatType, senderId: userId });
      assert.match(x.requests.at(-1).payload.text, /только в личном чате/);
      assert.equal(x.requests.at(-1).payload.text.includes(String(userId)), false);
    }
  } finally { x.close(); }
});

test("просмотр анкеты в группе или супергруппе не раскрывает персональные данные", async () => {
  const x = setup();
  try {
    addParticipant(x.db);
    x.db.findParticipantByTelegramId = () => { throw new Error("В группе нельзя читать анкету"); };
    for (const chatType of ["group", "supergroup"]) {
      await x.send("Моя анкета", { chatType });
      assert.equal(x.requests.at(-1).payload.text, "🔒 Просмотр анкеты доступен только в личном чате с ботом.");
    }
    assert.doesNotMatch(JSON.stringify(x.requests), /КонфиденциальноеИмя|\+79991234567|private-marker|Секретоград/);
  } finally { x.close(); }
});

test("подтверждение регистрации и ответ редактирования в группе не меняют записи", async () => {
  const x = setup();
  try {
    addDraft(x.db, "confirm");
    await x.send("✅ Подтвердить регистрацию", { chatType: "group" });
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.getDraft("telegram", userId).current_step, "confirm");

    const participant = addParticipant(x.db);
    x.db.saveDraft("telegram", userId, "profile_edit:city", {});
    await x.send("Новое место", { chatType: "supergroup" });
    assert.equal(x.db.getParticipant(participant.id).city, "Секретоград");
    assert.equal(x.db.getDraft("telegram", userId).current_step, "profile_edit:city");
  } finally { x.close(); }
});

test("редактирование анкеты в группе или супергруппе не создаёт черновик и не меняет данные", async () => {
  const x = setup();
  try {
    addParticipant(x.db);
    for (const chatType of ["group", "supergroup"]) {
      await x.send("✏️ Изменить данные", { chatType });
      assert.match(x.requests.at(-1).payload.text, /только в личном чате/i);
    }
    assert.equal(x.db.getDraft("telegram", userId), undefined);
    assert.equal(x.db.findParticipantByTelegramId(userId).first_name, "КонфиденциальноеИмя");
  } finally { x.close(); }
});

test("старая callback-кнопка в группе отклоняется до выполнения обработчиков", async () => {
  const x = setup();
  try {
    addParticipant(x.db);
    for (const [index, chatType] of ["group", "supergroup"].entries()) {
      await x.bot.handleUpdate({
        update_id: index + 1,
        callback_query: {
          id: `fake-callback-${index}`,
          from: { id: userId, is_bot: false, first_name: "Тест" },
          message: { message_id: index + 1, date: 1, chat: { id: -10077331, type: chatType } },
          chat_instance: "fake-chat",
          data: "old_profile_edit"
        }
      });
    }
    const answer = x.requests.find((request) => request.method === "answerCallbackQuery");
    assert.ok(answer);
    assert.match(answer.payload.text, /личный чат/i);
    assert.equal(x.requests.some((request) => request.method === "sendMessage"), false);
  } finally { x.close(); }
});

test("ошибка Telegram API регистрируется без текста анкеты и payload", async () => {
  const x = setup({ failSendMessage: true });
  const originalError = console.error;
  const logs = [];
  try {
    addParticipant(x.db);
    console.error = (...args) => logs.push(args.map(String).join(" "));
    let updateError;
    try {
      await x.send("Моя анкета");
    } catch (error) {
      updateError = error;
    }
    assert.ok(updateError, "Ошибка Telegram API должна прервать обработку этого сообщения");
    {
      // handleUpdate exposes middleware failures; polling forwards them to bot.catch.
      await x.bot.errorHandler(updateError);
    }
    const output = logs.join("\n");
    assert.match(output, /telegram_update_failed/);
    assert.match(output, /"telegram_method":"sendMessage"/);
    assert.match(output, /"telegram_error_code":500/);
    assert.doesNotMatch(output, /КонфиденциальноеИмя|\+79991234567|private-marker|Секретоград|simulated PII|PRIVACY_TEST_ONLY/);
    assert.equal(x.requests.filter((request) => request.method === "sendMessage").length, 1);
  } finally {
    console.error = originalError;
    x.close();
  }
});

test("ошибка grammY распознаётся как техническая ошибка без логирования объекта", () => {
  const { safeErrorDetails } = require("../src/error-handler");
  const error = new GrammyError("sensitive text", {
    ok: false,
    error_code: 403,
    description: "private payload text"
  }, "sendMessage", { text: "sensitive participant data" });
  const details = safeErrorDetails(error, 99);
  assert.deepEqual(details, {
    event: "telegram_update_failed",
    update_id: 99,
    error_type: "GrammyError",
    telegram_error_code: 403,
    telegram_method: "sendMessage"
  });
  assert.doesNotMatch(JSON.stringify(details), /sensitive|private payload/);
});
