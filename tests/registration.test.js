const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");
const modulePath = path.resolve(__dirname, "../src/registration.js");
const userId = 991234567;
function setup(policy = "https://policy.invalid/test") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-registration-"));
  process.env.DB_PATH = path.join(dir, "registration.sqlite");
  process.env.PRIVACY_POLICY_URL = policy;
  process.env.PRIVACY_POLICY_VERSION = "test-policy-v1";
  process.env.PRIVACY_POLICY_PUBLISHED = "true";
  process.env.PHONE_PROOF_SECRET = "synthetic-registration-test-secret-v1";
  delete require.cache[require.resolve("../src/database")];
  delete require.cache[require.resolve(modulePath)];
  delete require.cache[require.resolve("../src/participant-service")];
  const db = require("../src/database");
  let lastDbError = null;
  const realAdd = db.addParticipant;
  db.addParticipant = (...args) => { try { return realAdd(...args); } catch (error) { lastDbError = { code: error.code, message: error.message }; throw error; } };
  const bot = new Bot("123456:TEST_TOKEN_NOT_REAL", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require(modulePath).registerRegistration(bot);
  async function send(message) {
    const draft = message.text === "Согласен" ? db.getDraft("telegram", userId) : null;
    const update = draft?.current_step === "consent" ? { update_id: Math.floor(Math.random()*1e9), callback_query: { id: `cb-${Math.random()}`, from: { id: userId, is_bot: false, first_name: "Тест" }, chat_instance: "test", data: `mconsent:a:${draft.answers.consent_nonce}`, message: { message_id: 1, date: 1, chat: { id: userId, type: "private" }, from: { id: 123456, is_bot: true, first_name: "Test" }, text: "Согласие" } } } : { update_id: Math.floor(Math.random()*1e9), message: { message_id: 1, date: 1, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Тест" }, ...message } };
    let response;
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "sendMessage") { response = payload.text; return { ok: true, result: { message_id: 2, date: 1, chat: { id: userId, type: "private" }, text: payload.text } }; }
      if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") return { ok: true, result: true };
      return { ok: true, result: true };
    });
    await bot.handleUpdate(update);
    return response;
  }
  return { db, send, getLastDbError: () => lastDbError, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; delete process.env.PRIVACY_POLICY_URL; delete process.env.PRIVACY_POLICY_VERSION; delete process.env.PRIVACY_POLICY_PUBLISHED; delete process.env.PHONE_PROOF_SECRET; delete process.env.DEMO_MODE; delete require.cache[require.resolve("../src/participant-service")]; } };
}
const message = (text) => ({ text });
const contact = (id, number = "+79001234567") => ({ contact: { phone_number: number, user_id: id } });
test("нет ссылки политики — регистрация не начинается", async () => { const x=setup(""); try { assert.match(await x.send(message("Зарегистрироваться")), /PRIVACY_POLICY_URL/); assert.equal(x.db.getDraft("telegram",userId),undefined); } finally {x.close();} });
test("собственный контакт, шаги, сохранение черновика, подтверждение и дубликат", async () => { const x=setup(); try {
 await x.send(message("Зарегистрироваться")); assert.equal(x.db.getDraft("telegram",userId).current_step,"consent");
 assert.match(await x.send(message("Согласен")),/зовут/i); await x.send(message("ТестовоеИмя")); await x.send(message("ТестоваяФамилия"));
 assert.match(await x.send(contact(123)),/только ваш контакт/i); assert.equal(x.db.getDraft("telegram",userId).current_step,"phone");
 assert.match(await x.send(contact(userId)),/город/i); assert.equal(x.db.getDraft("telegram",userId).answers.phone,"+79001234567");
 await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram")); assert.match(await x.send(message("Пропустить")),/Проверьте ваши данные/i);
 const confirmation = await x.send(message("✅ Подтвердить регистрацию")); assert.match(confirmation,/Регистрация завершена/i); assert.equal(x.getLastDbError(),null); assert.equal(x.db.getParticipantCount(),1); assert.ok(x.db.findParticipantByTelegramId(userId)); assert.equal(x.db.findParticipantByTelegramId(userId).consent_version,"test-policy-v1"); assert.ok(x.db.findParticipantByTelegramId(userId).consent_at); assert.equal(x.db.getDraft("telegram",userId),undefined);
 assert.match(await x.send(message("Зарегистрироваться")),/уже зарегистрированы/i); assert.equal(x.db.getParticipantCount(),1);
 } finally {x.close();} });
test("некорректный email и восстановление черновика после повторного открытия базы", async () => { const x=setup(); try { await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Тест")); await x.send(message("Проверка")); await x.send(contact(userId)); await x.send(message("Пропустить")); assert.match(await x.send(message("не email")),/корректный email/i); assert.equal(x.db.getDraft("telegram",userId).current_step,"email"); x.db.closeDatabase(); delete require.cache[require.resolve("../src/database")]; const db=require("../src/database"); assert.equal(db.getDraft("telegram",userId).current_step,"email"); db.closeDatabase(); fs.rmSync(path.dirname(process.env.DB_PATH),{recursive:true,force:true}); delete process.env.DB_PATH; } finally { try{x.db.closeDatabase()}catch{} } });
test("отмена удаляет черновик", async () => { const x=setup(); try { await x.send(message("Зарегистрироваться")); assert.ok(x.db.getDraft("telegram",userId)); assert.match(await x.send(message("❌ Отменить регистрацию")),/отменена/i); assert.equal(x.db.getDraft("telegram",userId),undefined); } finally {x.close();} });







test("кнопка «Назад» возвращает к имени и сохраняет прежний ответ", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Алиса"));
    assert.equal(x.db.getDraft("telegram",userId).answers.first_name,"Алиса");
    assert.match(await x.send(message("⬅️ Назад")),/Как вас зовут/);
    assert.equal(x.db.getDraft("telegram",userId).current_step,"first_name");
    assert.equal(x.db.getDraft("telegram",userId).answers.first_name,"Алиса");
    await x.send(message("Алиса Новая")); assert.equal(x.db.getDraft("telegram",userId).answers.first_name,"Алиса Новая");
    assert.equal(x.db.getDraft("telegram",userId).answers.last_name,undefined);
  } finally { x.close(); }
});

test("необязательный город пропускается и сохраняется пустым", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Борис")); await x.send(message("Иванов")); await x.send(contact(userId));
    assert.match(await x.send(message("Пропустить")),/электронную почту/i);
    const d=x.db.getDraft("telegram",userId); assert.equal(d.current_step,"email"); assert.equal(d.answers.city,null);
  } finally { x.close(); }
});

test("назад на этапе города сохраняет остальные предыдущие ответы", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Вера")); await x.send(message("Петрова")); await x.send(contact(userId));
    await x.send(message("Екатеринбург")); assert.match(await x.send(message("⬅️ Назад")),/В каком городе/i);
    const d=x.db.getDraft("telegram",userId); assert.equal(d.current_step,"city"); assert.equal(d.answers.first_name,"Вера"); assert.equal(d.answers.last_name,"Петрова"); assert.equal(d.answers.city,"Екатеринбург");
  } finally { x.close(); }
});

test("отмена удаляет черновик с этапов согласия и заполнения анкеты", async () => {
  for (const advanced of [false,true]) { const x=setup(); try {
    await x.send(message("Зарегистрироваться")); if (advanced) { await x.send(message("Согласен")); await x.send(message("Тест")); }
    assert.ok(x.db.getDraft("telegram",userId)); await x.send(message("❌ Отменить регистрацию")); assert.equal(x.db.getDraft("telegram",userId),undefined); assert.equal(x.db.getParticipantCount(),0);
  } finally { x.close(); } }
});

test("ответ «Другое» принимает свой текст и сохраняет его", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Лев")); await x.send(message("Смирнов")); await x.send(contact(userId)); await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram"));
    assert.match(await x.send(message("Другое")),/Напишите/i); assert.equal(x.db.getDraft("telegram",userId).current_step,"referral_source");
    assert.match(await x.send(message("На встрече книжного клуба")),/Проверьте ваши данные/i); assert.equal(x.db.getDraft("telegram",userId).answers.referral_source,"На встрече книжного клуба");
  } finally { x.close(); }
});

test("регистрация ограничивает длину города, email и своего источника и сохраняет допустимую границу", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("ТестовоеИмя")); await x.send(message("ТестоваяФамилия")); await x.send(contact(userId));
    const tooLongCity=await x.send(message("Г".repeat(101))); assert.match(tooLongCity,/100 символов/);
    assert.equal(x.db.getDraft("telegram",userId).current_step,"city"); assert.equal(x.db.getDraft("telegram",userId).answers.city,undefined);
    await x.send(message("Г".repeat(100))); assert.equal(x.db.getDraft("telegram",userId).answers.city,"Г".repeat(100));
    assert.match(await x.send(message("не email")),/корректный email/);
    const maxEmail=`${"a".repeat(248)}@x.com`; await x.send(message(maxEmail)); assert.equal(x.db.getDraft("telegram",userId).answers.email,maxEmail);
    await x.send(message("Telegram")); await x.send(message("Другое"));
    assert.match(await x.send(message("И".repeat(121))),/120 символов/);
    assert.equal(x.db.getDraft("telegram",userId).current_step,"referral_source");
    await x.send(message("И".repeat(120))); assert.equal(x.db.getDraft("telegram",userId).answers.referral_source,"И".repeat(120));
    assert.match(await x.send(message("✅ Подтвердить регистрацию")),/Регистрация завершена/);
    const saved=x.db.findParticipantByTelegramId(userId); assert.equal(saved.city,"Г".repeat(100)); assert.equal(saved.email,maxEmail); assert.equal(saved.referral_source,"И".repeat(120));
  } finally {x.close();}
});

test("назад на шаге телефона возвращает к фамилии, не принимает кнопку за номер", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Имя")); await x.send(message("Фамилия"));
    assert.match(await x.send(message("⬅️ Назад")),/фамилию/i);
    assert.equal(x.db.getDraft("telegram",userId).current_step,"last_name");
    await x.send(message("НоваяФамилия")); assert.equal(x.db.getDraft("telegram",userId).current_step,"phone");
    await x.send(message("⬅️ Назад")); assert.equal(x.db.getDraft("telegram",userId).current_step,"last_name");
  } finally {x.close();}
});

test("возврат из своего варианта источника сбрасывает ожидание текста и позволяет выбрать снова", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Имя")); await x.send(message("Фамилия")); await x.send(contact(userId));
    await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram")); await x.send(message("Другое"));
    assert.match(await x.send(message("⬅️ Назад")),/Откуда вы узнали/);
    const draft=x.db.getDraft("telegram",userId); assert.equal(draft.current_step,"referral_source"); assert.equal(draft.answers.awaiting_referral_detail,undefined);
    await x.send(message("Пропустить"));
    assert.equal(x.db.getDraft("telegram",userId).current_step,"confirm"); assert.equal(x.db.getDraft("telegram",userId).answers.referral_source,null);
  } finally {x.close();}
});

test("после заполнения анкеты можно исправить поле, вернуться к сводке и подтвердить", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Имя")); await x.send(message("Фамилия")); await x.send(contact(userId));
    await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram")); await x.send(message("Пропустить"));
    await x.send(message("✏️ Исправить данные")); await x.send(message("Город"));
    const corrected=await x.send(message("Тестоград")); assert.match(corrected,/Город: Тестоград/);
    assert.equal(x.db.getDraft("telegram",userId).current_step,"confirm");
    await x.send(message("✏️ Исправить данные"));
    const summary=await x.send(message("⬅️ Назад")); assert.match(summary,/Проверьте ваши данные/); assert.match(summary,/Город: Тестоград/);
    assert.match(await x.send(message("✅ Подтвердить регистрацию")),/Регистрация завершена/);
    assert.equal(x.db.findParticipantByTelegramId(userId).city,"Тестоград");
  } finally {x.close();}
});

test("настоящая регистрация возвращается из ввода Другое и предлагает варианты источника", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Имя")); await x.send(message("Фамилия")); await x.send(contact(userId));
    await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram")); await x.send(message("Другое"));
    assert.match(await x.send(message("⬅️ Назад")),/Откуда вы узнали/);
    const draft=x.db.getDraft("telegram",userId); assert.equal(draft.current_step,"referral_source"); assert.equal(draft.answers.awaiting_referral_detail,undefined);
    await x.send(message("Мероприятие")); assert.equal(x.db.getDraft("telegram",userId).answers.referral_source,"Мероприятие");
    assert.equal(x.db.getDraft("telegram",userId).current_step,"confirm");
  } finally {x.close();}
});

test("черновик регистрации не позволяет очистить email, выбранный способом связи", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Имя")); await x.send(message("Фамилия")); await x.send(contact(userId));
    await x.send(message("Пропустить")); await x.send(message("email@example.invalid")); await x.send(message("Электронная почта")); await x.send(message("Пропустить"));
    await x.send(message("✏️ Исправить данные")); await x.send(message("Электронная почта"));
    const denied=await x.send(message("Пропустить")); assert.match(denied,/Сначала измените предпочтительный способ связи/);
    const draft=x.db.getDraft("telegram",userId); assert.equal(draft.current_step,"email"); assert.equal(draft.answers.email,"email@example.invalid");
    await x.send(message("⬅️ Назад"));
    assert.match(await x.send(message("✅ Подтвердить регистрацию")),/Регистрация завершена/);
    assert.equal(x.db.findParticipantByTelegramId(userId).email,"email@example.invalid");
  } finally {x.close();}
});

test("выбор конкретного поля меняет только фамилию и возвращает к сводке", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Мария")); await x.send(message("Старая")); await x.send(contact(userId)); await x.send(message("Казань")); await x.send(message("Пропустить")); await x.send(message("Telegram")); await x.send(message("От друзей или знакомых"));
    assert.match(await x.send(message("✏️ Исправить данные")),/Какое поле исправить/);
    assert.match(await x.send(message("Фамилия")),/Введите вашу фамилию/);
    assert.match(await x.send(message("Новая")),/Проверьте ваши данные/);
    const a=x.db.getDraft("telegram",userId).answers; assert.equal(a.last_name,"Новая"); assert.equal(a.first_name,"Мария"); assert.equal(a.city,"Казань"); assert.equal(a.preferred_contact,"Telegram");
  } finally { x.close(); }
});

test("изменённый ответ анкеты сохраняется после повторного открытия SQLite", async () => {
  const x=setup(); const file=process.env.DB_PATH; try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен")); await x.send(message("Ирина")); await x.send(message("СтараяФамилия"));
    const changed=x.db.getDraft("telegram",userId).answers; changed.last_name="НоваяФамилия"; x.db.saveDraft("telegram",userId,"confirm",changed);
    x.db.closeDatabase(); delete require.cache[require.resolve("../src/database")]; const reopened=require("../src/database");
    assert.equal(reopened.getDraft("telegram",userId).answers.last_name,"НоваяФамилия"); reopened.closeDatabase(); fs.rmSync(path.dirname(file),{recursive:true,force:true}); delete process.env.DB_PATH;
  } finally { try{x.db.closeDatabase()}catch{} }
});

test("черновик нельзя продолжить или подтвердить, если политика стала недоступна", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться"));
    await x.send(message("Согласен"));
    await x.send(message("Тест"));
    const before = x.db.getDraft("telegram", userId);
    delete process.env.PRIVACY_POLICY_URL;
    assert.match(await x.send(message("ТестоваяФамилия")), /PRIVACY_POLICY_URL/);
    assert.deepEqual(x.db.getDraft("telegram", userId), before);

    const answers = { ...before.answers, first_name: "Тест", last_name: "ТестоваяФамилия", phone: "+79001234567", phone_confirmed_at: new Date().toISOString(), phone_confirmed_by: String(userId), preferred_contact: "Telegram", personal_data_consent: true, consent_at: new Date().toISOString(), consent_version: "test-policy-v1", consent_given_by: String(userId) };
    x.db.saveDraft("telegram", userId, "confirm", answers);
    assert.match(await x.send(message("✅ Подтвердить регистрацию")), /PRIVACY_POLICY_URL/);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.ok(x.db.getDraft("telegram", userId));
    assert.match(await x.send(message("❌ Отменить регистрацию")), /отменена/i);
    assert.equal(x.db.getDraft("telegram", userId), undefined);
  } finally { x.close(); }
});

test("черновик с устаревшей версией политики сохраняется, но не завершается", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен"));
    await x.send(message("Тест")); await x.send(message("Фамилия")); await x.send(contact(userId));
    await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram")); await x.send(message("Пропустить"));
    const before = x.db.getDraft("telegram", userId);
    process.env.PRIVACY_POLICY_VERSION = "test-policy-v2";
    assert.match(await x.send(message("✅ Подтвердить регистрацию")), /версия политики изменилась/i);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.deepEqual(x.db.getDraft("telegram", userId), before);
  } finally { x.close(); }
});

test("обычная регистрация полностью блокируется в demo-режиме без записи и без изменения черновика", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться"));
    const before = x.db.getDraft("telegram", userId);
    process.env.DEMO_MODE = "true";
    assert.match(await x.send(message("Зарегистрироваться")), /отключена в демонстрационном режиме/i);
    assert.match(await x.send(message("Согласен")), /отключена в демонстрационном режиме/i);
    assert.deepEqual(x.db.getDraft("telegram", userId), before);
    const forged = { ...before.answers, first_name: "Тест", last_name: "Демо", phone: "+79001234567", phone_confirmed_at: new Date().toISOString(), phone_confirmed_by: String(userId), preferred_contact: "Telegram", personal_data_consent: true, consent_at: new Date().toISOString(), consent_version: "test-policy-v1", consent_given_by: String(userId) };
    x.db.saveDraft("telegram", userId, "confirm", forged);
    assert.match(await x.send(message("✅ Подтвердить регистрацию")), /отключена в демонстрационном режиме/i);
    assert.equal(x.db.getParticipantCount(), 0);
    assert.equal(x.db.findParticipantByTelegramId(userId), undefined);
  } finally { x.close(); }
});

test("повторное подтверждение готовой анкеты не создаёт дубликат", async () => {
  const x=setup(); try {
    await x.send(message("Зарегистрироваться")); await x.send(message("Согласен"));
    await x.send(message("Тест")); await x.send(message("Пользователь")); await x.send(contact(userId));
    await x.send(message("Пропустить")); await x.send(message("Пропустить")); await x.send(message("Telegram")); await x.send(message("Пропустить"));
    assert.equal(x.db.getDraft("telegram", userId).current_step, "confirm");
    await x.send(message("✅ Подтвердить регистрацию"));
    assert.equal(x.db.getParticipantCount(), 1);
    await x.send(message("✅ Подтвердить регистрацию"));
    assert.equal(x.db.getParticipantCount(), 1);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE platform='telegram' AND messenger_user_id=?").get(String(userId)).count, 1);
  } finally { x.close(); }
});



