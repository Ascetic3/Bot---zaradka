const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

const userId = 862001001;
const otherId = 862001002;
const envKeys = ["DB_PATH", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "PRIVACY_POLICY_PUBLISHED", "PHONE_PROOF_SECRET", "DEMO_MODE"];

function setup({ url = "https://club.example.org/privacy?lang=ru&revision=1", version = "draft-test-v1", published = true, demo = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-consent-screen-"));
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.DB_PATH = path.join(directory, "temporary.sqlite");
  if (url === undefined) delete process.env.PRIVACY_POLICY_URL; else process.env.PRIVACY_POLICY_URL = url;
  if (version == null) delete process.env.PRIVACY_POLICY_VERSION; else process.env.PRIVACY_POLICY_VERSION = version;
  if (published) process.env.PRIVACY_POLICY_PUBLISHED = "true"; else delete process.env.PRIVACY_POLICY_PUBLISHED;
  process.env.PHONE_PROOF_SECRET = "synthetic-consent-screen-secret-v1";
  process.env.DEMO_MODE = String(demo);
  for (const name of ["../src/database", "../src/participant-service", "../src/registration", "../src/registration-preview"]) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  const bot = new Bot("123456:CONSENT_SCREEN_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require("../src/registration").registerRegistration(bot);
  const requests = [];
  bot.api.config.use(async (_previous, method, payload) => {
    requests.push({ method, payload });
    if (method === "sendMessage") return { ok: true, result: { message_id: requests.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
    if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") return { ok: true, result: true };
    return { ok: true, result: true };
  });
  let updateId = 0;
  const send = async (text, { id = userId, type = "private", chatId = id, contact = null } = {}) => {
    const message = { message_id: ++updateId, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Synthetic" } };
    if (contact) message.contact = contact; else message.text = text;
    await bot.handleUpdate({ update_id: updateId, message });
    return requests.filter(item => item.method === "sendMessage").at(-1)?.payload;
  };
  const click = async (data, { id = userId, type = "private", chatId = id } = {}) => {
    await bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: "callback-" + updateId, from: { id, is_bot: false, first_name: "Synthetic" }, chat_instance: "synthetic",
      data, message: { message_id: 1, date: 1, chat: { id: chatId, type }, from: { id: 123456, is_bot: true, first_name: "Test" }, text: "Согласие" }
    } });
    return requests.filter(item => item.method === "sendMessage").at(-1)?.payload;
  };
  const startRegistration = () => send("Зарегистрироваться");
  const consentButton = (action = "a") => {
    const nonce = db.getDraft("telegram", userId)?.answers?.consent_nonce;
    return nonce ? "mconsent:" + action + ":" + nonce : null;
  };
  return {
    db, bot, requests, send, click, startRegistration, consentButton,
    lastMethod(method) { return requests.filter(item => item.method === method).at(-1); },
    close() { try { db.closeDatabase(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); for (const key of envKeys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } for (const name of ["../src/database", "../src/participant-service", "../src/registration", "../src/registration-preview"]) delete require.cache[require.resolve(name)]; }
  };
}

test("экран согласия показывает кликабельную HTTPS-ссылку без длинного URL в тексте", async () => {
  const x = setup(); try {
    const sent = await x.startRegistration();
    assert.match(sent.text, /Согласие на обработку персональных данных/);
    assert.equal(sent.parse_mode, "HTML");
    assert.match(sent.text, /<a href="https:\/\/club\.example\.org\/privacy\?lang=ru&amp;revision=1">Политикой обработки персональных данных<\/a>/);
    assert.doesNotMatch(sent.text.replace(/<a href="[^"]+">/g, "<a>").replace(/<[^>]*>/g, ""), /https?:\/\//);
  } finally { x.close(); }
});

test("под сообщением ровно две inline-кнопки принятия и отказа", async () => {
  const x = setup(); try {
    const sent = await x.startRegistration();
    assert.deepEqual(sent.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [["✅ Принимаю"], ["❌ Отказываюсь"]]);
    assert.ok(sent.reply_markup.inline_keyboard[0][0].callback_data);
    assert.ok(sent.reply_markup.inline_keyboard[1][0].callback_data);
    assert.equal(x.db.getDraft("telegram", userId).current_step, "consent");
  } finally { x.close(); }
});

test("принятие фиксирует текущую версию и HMAC-квитанцию, затем открывает первый вопрос", async () => {
  const x = setup(); try {
    await x.startRegistration();
    const sent = await x.click(x.consentButton("a"));
    const draft = x.db.getDraft("telegram", userId);
    assert.match(sent.text, /Как вас зовут/);
    assert.equal(draft.current_step, "first_name");
    assert.equal(draft.answers.personal_data_consent, true);
    assert.equal(draft.answers.consent_version, "draft-test-v1");
    assert.equal(draft.answers.consent_given_by, String(userId));
    assert.ok(draft.answers.consent_at);
    assert.ok(draft.answers.consent_attestation.signature);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.ok(x.lastMethod("editMessageReplyMarkup"), JSON.stringify(x.requests.map(item => item.method)));
    assert.match(JSON.stringify(x.lastMethod("editMessageReplyMarkup").payload), /inline_keyboard/);
  } finally { x.close(); }
});

test("отказ удаляет текущий черновик, не фиксирует согласие и возвращает меню", async () => {
  const x = setup(); try {
    await x.startRegistration();
    const sent = await x.click(x.consentButton("d"));
    assert.match(sent.text, /Вы отказались от обработки данных/);
    assert.match(sent.text, /Добро пожаловать в клуб/);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.ok(sent.reply_markup.keyboard.some(row => row.some(button => button.text === "Зарегистрироваться")));
    assert.ok(x.lastMethod("editMessageReplyMarkup"), JSON.stringify(x.requests.map(item => item.method)));
    assert.match(JSON.stringify(x.lastMethod("editMessageReplyMarkup").payload), /inline_keyboard/);
  } finally { x.close(); }
});

test("повторное нажатие принятия считается устаревшим и не меняет этап второй раз", async () => {
  const x = setup(); try {
    await x.startRegistration(); const old = x.consentButton("a");
    await x.click(old); const stage = x.db.getDraft("telegram", userId).current_step;
    await x.click(old);
    assert.equal(x.db.getDraft("telegram", userId).current_step, stage);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.match(x.lastMethod("answerCallbackQuery").payload.text, /устарела|обработана/i);
  } finally { x.close(); }
});

test("старая версия политики не принимается, а пользователю показывается новая редакция", async () => {
  const x = setup(); try {
    await x.startRegistration(); const old = x.consentButton("a");
    process.env.PRIVACY_POLICY_VERSION = "draft-test-v2";
    const refreshed = await x.click(old);
    const draft = x.db.getDraft("telegram", userId);
    assert.match(refreshed.text, /Политикой обработки персональных данных/);
    assert.equal(draft.current_step, "consent");
    assert.equal(draft.answers.policy_version, "draft-test-v2");
    assert.equal(draft.answers.personal_data_consent, undefined);
    assert.notEqual(draft.answers.consent_nonce, old.split(":").at(-1));
    await x.click(old);
    assert.equal(x.db.getDraft("telegram", userId).current_step, "consent");
    await x.click(x.consentButton("a"));
    assert.equal(x.db.getDraft("telegram", userId).current_step, "first_name");
    assert.equal(x.db.getDraft("telegram", userId).answers.consent_version, "draft-test-v2");
  } finally { x.close(); }
});

test("без ссылки на политику регистрация не создаёт черновик", async () => {
  const x = setup({ url: "" }); try {
    const sent = await x.startRegistration();
    assert.match(sent.text, /PRIVACY_POLICY_URL/);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

test("небезопасный или некорректный URL не считается действующей политикой", async () => {
  for (const url of ["http://club.example.org/privacy", "javascript:alert(1)", "not a URL"]) {
    const x = setup({ url }); try {
      assert.match((await x.startRegistration()).text, /PRIVACY_POLICY_URL/);
      assert.equal(x.db.getDraft("telegram", userId), undefined);
    } finally { x.close(); }
  }
});

test("отсутствующая версия политики блокирует регистрацию", async () => {
  const x = setup({ version: null }); try {
    assert.match((await x.startRegistration()).text, /PRIVACY_POLICY_VERSION/);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

test("одного URL и версии недостаточно без отметки заполнения, утверждения и публикации", async () => {
  const x = setup({ published: false }); try {
    assert.match((await x.startRegistration()).text, /PRIVACY_POLICY_PUBLISHED/);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

test("другой Telegram ID не может принять согласие из чужого черновика", async () => {
  const x = setup(); try {
    await x.startRegistration(); const before = x.db.getDraft("telegram", userId);
    await x.click(x.consentButton("a"), { id: otherId });
    assert.equal(x.db.getDraft("telegram", otherId), undefined);
    assert.deepEqual(x.db.getDraft("telegram", userId), before);
    assert.equal(x.db.getParticipantCount(), 0);
  } finally { x.close(); }
});

test("callback согласия в группе не меняет черновик", async () => {
  const x = setup(); try {
    await x.startRegistration(); const before = x.db.getDraft("telegram", userId);
    await x.click(x.consentButton("a"), { type: "supergroup", chatId: -100862001003 });
    assert.deepEqual(x.db.getDraft("telegram", userId), before);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.match(x.lastMethod("answerCallbackQuery").payload.text, /личном чате/i);
  } finally { x.close(); }
});

test("согласие позволяет завершить прежний регистрационный сценарий с HMAC и записью участника", async () => {
  const x = setup(); try {
    await x.startRegistration(); await x.click(x.consentButton("a"));
    await x.send("СинтетическоеИмя"); await x.send("СинтетическаяФамилия");
    await x.send(null, { contact: { user_id: userId, phone_number: "+79001112233" } });
    await x.send("Пропустить"); await x.send("Пропустить"); await x.send("Telegram"); await x.send("Пропустить");
    assert.equal(x.db.getDraft("telegram", userId).current_step, "confirm");
    await x.send("✅ Подтвердить регистрацию");
    assert.equal(x.db.getParticipantCount(), 1);
    assert.equal(x.db.findParticipantByTelegramId(userId).consent_version, "draft-test-v1");
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

test("деморежим сохраняет предварительный просмотр и блокирует настоящую регистрацию", async () => {
  const x = setup({ demo: true, published: false }); try {
    const previewModule = require("../src/registration-preview");
    previewModule.registerRegistrationPreview(x.bot, { getRole: id => id === userId ? "owner" : null });
    const before = x.db.getParticipantCount();
    assert.match((await x.startRegistration()).text, /отключена в демонстрационном режиме/i);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
    await x.bot.handleUpdate({ update_id: 999, message: { message_id: 999, date: 1, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false }, text: "/preview_registration" } });
    assert.match(x.requests.filter(item => item.method === "sendMessage").at(-1).payload.text, /демонстрационном режиме/i);
    assert.equal(x.db.getParticipantCount(), before);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

