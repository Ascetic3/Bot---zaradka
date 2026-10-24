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
  delete require.cache[require.resolve("../src/database")];
  delete require.cache[require.resolve(modulePath)];
  const db = require("../src/database");
  let lastDbError = null;
  const realAdd = db.addParticipant;
  db.addParticipant = (...args) => { try { return realAdd(...args); } catch (error) { lastDbError = { code: error.code, message: error.message }; throw error; } };
  const bot = new Bot("123456:TEST_TOKEN_NOT_REAL", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require(modulePath).registerRegistration(bot);
  async function send(message) {
    const update = { update_id: Math.floor(Math.random()*1e9), message: { message_id: 1, date: 1, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Тест" }, ...message } };
    let response;
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "sendMessage") { response = payload.text; return { ok: true, result: { message_id: 2, date: 1, chat: { id: userId, type: "private" }, text: payload.text } }; }
      return prev(method, payload, signal);
    });
    await bot.handleUpdate(update);
    return response;
  }
  return { db, send, getLastDbError: () => lastDbError, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; } };
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
 const confirmation = await x.send(message("✅ Подтвердить регистрацию")); assert.match(confirmation,/Регистрация завершена/i); assert.equal(x.getLastDbError(),null); assert.equal(x.db.getParticipantCount(),1); assert.ok(x.db.findParticipantByTelegramId(userId)); assert.equal(x.db.getDraft("telegram",userId),undefined);
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



