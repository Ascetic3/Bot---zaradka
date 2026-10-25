const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");
const userId = 88770011;
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-profile-"));
  process.env.DB_PATH = path.join(dir, "profile.sqlite");
  delete require.cache[require.resolve("../src/database")];
  delete require.cache[require.resolve("../src/profile")];
  const db = require("../src/database");
  const bot = new Bot("123456:PROFILE_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "test", username: "test_bot" } });
  require("../src/profile").registerProfile(bot);
  const sent=[];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") { sent.push(payload); return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: userId, type: "private" }, text: payload.text } }; }
    throw new Error(`Unexpected Telegram API call: ${method}`);
  });
  let updateId=0;
  async function send(text, senderId=userId) {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: senderId, type: "private" }, from: { id: senderId, is_bot: false, first_name: "Участник" }, text } });
    return sent.at(-1);
  }
  function add(id, extra={}) { return db.addParticipant({ first_name: `Участник${id}`, last_name: null, phone: `+7900${String(id).padStart(7,"0")}`, ...extra }, { platform: "telegram", messenger_user_id: id }); }
  return { db, send, add, sent, close() { db.closeDatabase(); fs.rmSync(dir,{recursive:true,force:true}); delete process.env.DB_PATH; } };
}
test("зарегистрированный пользователь видит только свою анкету", async () => { const x=setup(); try { const own=x.add(userId,{last_name:"Петров",city:"Тестоград",email:"test@example.invalid",preferred_contact:"Telegram",referral_source:"Друзья"}); x.add(userId+1,{first_name:"Чужой",last_name:"Чужая",phone:"+79009999999"}); const msg=await x.send("Моя анкета"); assert.match(msg.text,/Участник88770011/); assert.match(msg.text,/Петров/); assert.doesNotMatch(msg.text,/Чужой|Чужая/); assert.match(msg.text,/Дата регистрации:/); assert.equal(msg.reply_markup.keyboard[0][0].text,"✏️ Изменить данные"); assert.equal(msg.reply_markup.keyboard[1][0].text,"🔐 Мои данные"); assert.equal(msg.reply_markup.keyboard[2][0].text,"🔗 Связанные аккаунты"); assert.equal(x.db.getParticipant(own.id).first_name,"Участник88770011"); } finally {x.close();} });
test("незарегистрированный получает приглашение зарегистрироваться", async () => { const x=setup(); try { const msg=await x.send("Моя анкета"); assert.equal(msg.text,"Вы ещё не зарегистрированы в клубе „Магия утра“. ☀️\n\nДля создания анкеты нажмите „Зарегистрироваться“."); assert.equal(x.db.getParticipantCount(),0); } finally {x.close();} });
test("анкета с отозванным согласием не раскрывается и не называется незарегистрированной", async () => { const x=setup(); try { const p=x.add(userId,{first_name:"СкрытоеИмя",personal_data_consent:true,consent_at:"2026-10-19T10:00:00.000Z",consent_version:"test-policy-v1"}); x.db.db.prepare("UPDATE participants SET personal_data_consent=0,consent_withdrawn_at=? WHERE id=?").run("2026-10-20T10:00:00.000Z",p.id); const msg=await x.send("Моя анкета"); assert.equal(msg.text,"Просмотр анкеты временно ограничен. Обратитесь к организатору клуба."); assert.doesNotMatch(msg.text,/СкрытоеИмя|зарегистрированы/); } finally {x.close();} });
test("пустые поля анкеты показываются как «Не указано»", async () => { const x=setup(); try { x.add(userId); const msg=await x.send("Моя анкета"); for (const field of ["Фамилия","Город проживания","Email","Предпочтительный способ связи","Откуда узнали о клубе"]) assert.match(msg.text,new RegExp(`${field}: Не указано`)); } finally {x.close();} });
test("повторный просмотр не меняет запись участника", async () => { const x=setup(); try { const p=x.add(userId,{city:"Тестоград"}); const before=x.db.getParticipant(p.id); const first=await x.send("Моя анкета"); const second=await x.send("Моя анкета"); assert.equal(first.text,second.text); assert.deepEqual(x.db.getParticipant(p.id),before); assert.equal(x.db.getParticipantCount(),1); } finally {x.close();} });
test("кнопка возврата показывает главное меню", async () => { const x=setup(); try { const msg=await x.send("🏠 Главное меню"); assert.match(msg.text,/Добро пожаловать в клуб/); assert.equal(msg.reply_markup.keyboard[0][0].text,"Зарегистрироваться"); assert.equal(msg.reply_markup.keyboard[1][0].text,"Моя анкета"); assert.equal(msg.reply_markup.keyboard[2][0].text,"🔐 Мои данные"); assert.equal(msg.reply_markup.keyboard[3][0].text,"🔗 Связанные аккаунты"); } finally {x.close();} });

test("имя и фамилия редактируются отдельно и обновляются в SQLite", async () => { const x=setup(); try { x.add(userId,{last_name:"Старая"}); await x.send("Моя анкета"); await x.send("✏️ Изменить данные"); await x.send("Имя"); await x.send("НовоеИмя"); assert.equal(x.db.findParticipantByTelegramId(userId).first_name,"НовоеИмя"); await x.send("✏️ Изменить данные"); await x.send("Фамилия"); await x.send("НоваяФамилия"); assert.equal(x.db.findParticipantByTelegramId(userId).last_name,"НоваяФамилия"); assert.equal(x.db.getParticipantCount(),1); } finally {x.close();} });
test("необязательное поле очищается, email валидируется и требуется для способа связи email", async () => { const x=setup(); try { x.add(userId,{city:"Казань",email:null}); await x.send("✏️ Изменить данные"); await x.send("Город"); await x.send("Очистить поле"); assert.equal(x.db.findParticipantByTelegramId(userId).city,null); await x.send("✏️ Изменить данные"); await x.send("Предпочтительный способ связи"); const needEmail=await x.send("Электронная почта"); assert.match(needEmail.text,/Сначала добавьте/); assert.equal(x.db.findParticipantByTelegramId(userId).preferred_contact,null); await x.send("✏️ Изменить данные"); await x.send("Электронная почта"); const bad=await x.send("непочта"); assert.match(bad.text,/корректный email/); assert.equal(x.db.findParticipantByTelegramId(userId).email,null); await x.send("test@example.invalid"); assert.equal(x.db.findParticipantByTelegramId(userId).email,"test@example.invalid"); } finally {x.close();} });
test("отмена редактирования оставляет исходные данные без изменений", async () => { const x=setup(); try { x.add(userId,{city:"Омск"}); await x.send("✏️ Изменить данные"); await x.send("Город"); await x.send("Отмена"); assert.equal(x.db.findParticipantByTelegramId(userId).city,"Омск"); assert.equal(x.db.getDraft("telegram",userId),undefined); } finally {x.close();} });
test("редактирование связано только с Telegram ID отправителя", async () => { const x=setup(); try { x.add(userId,{first_name:"Свой"}); x.add(userId+1,{first_name:"Чужой"}); await x.send("✏️ Изменить данные",userId+1); await x.send("Имя",userId+1); await x.send("Подмена",userId+1); assert.equal(x.db.findParticipantByTelegramId(userId+1).first_name,"Подмена"); assert.equal(x.db.findParticipantByTelegramId(userId).first_name,"Свой"); } finally {x.close();} });
test("незавершённое редактирование сохраняется в черновике после переоткрытия базы и не меняет анкету само", async () => { const x=setup(); const file=process.env.DB_PATH; try { x.add(userId,{first_name:"До"}); await x.send("✏️ Изменить данные"); await x.send("Имя"); await x.send("После"); assert.equal(x.db.findParticipantByTelegramId(userId).first_name,"После"); const updated=x.db.findParticipantByTelegramId(userId); await x.send("✏️ Изменить данные"); await x.send("Фамилия"); x.db.closeDatabase(); delete require.cache[require.resolve("../src/database")]; const db=require("../src/database"); assert.equal(db.getDraft("telegram",userId).current_step,"profile_edit:last_name"); assert.equal(db.findParticipantByTelegramId(userId).first_name,updated.first_name); db.closeDatabase(); fs.rmSync(path.dirname(file),{recursive:true,force:true}); delete process.env.DB_PATH; } finally {try{x.db.closeDatabase()}catch{}} });

test("редактирование применяет общие пределы города и источника и принимает предельную длину", async () => {
  const x=setup(); try {
    x.add(userId,{last_name:"Тестовая",city:"Старый город",referral_source:"Друзья",preferred_contact:"Telegram"});
    await x.send("✏️ Изменить данные"); await x.send("Город");
    const longCity=await x.send("Г".repeat(101)); assert.match(longCity.text,/100 символов/);
    assert.equal(x.db.findParticipantByTelegramId(userId).city,"Старый город");
    await x.send("Г".repeat(100)); assert.equal(x.db.findParticipantByTelegramId(userId).city,"Г".repeat(100));
    await x.send("✏️ Изменить данные"); await x.send("Откуда узнали о клубе");
    const longSource=await x.send("И".repeat(121)); assert.match(longSource.text,/120 символов/);
    assert.equal(x.db.findParticipantByTelegramId(userId).referral_source,"Друзья");
    await x.send("И".repeat(120)); assert.equal(x.db.findParticipantByTelegramId(userId).referral_source,"И".repeat(120));
  } finally {x.close();}
});

test("редактирование email проверяет формат и максимальную длину", async () => {
  const x=setup(); try {
    x.add(userId,{last_name:"Тестовая",email:"old@example.invalid",preferred_contact:"Telegram"});
    await x.send("✏️ Изменить данные"); await x.send("Электронная почта");
    const invalid=await x.send("это не email"); assert.match(invalid.text,/корректный email/);
    assert.equal(x.db.findParticipantByTelegramId(userId).email,"old@example.invalid");
    const tooLong=await x.send(`${"a".repeat(249)}@x.com`); assert.match(tooLong.text,/254 символов/);
    assert.equal(x.db.findParticipantByTelegramId(userId).email,"old@example.invalid");
    const maximum=`${"a".repeat(248)}@x.com`; await x.send(maximum);
    assert.equal(x.db.findParticipantByTelegramId(userId).email,maximum);
  } finally {x.close();}
});

test("email нельзя очистить, пока он выбран способом связи, но можно очистить после смены способа", async () => {
  const x=setup(); try {
    x.add(userId,{last_name:"Тестовая",email:"ok@example.invalid",preferred_contact:"Электронная почта"});
    await x.send("✏️ Изменить данные"); await x.send("Электронная почта");
    const denied=await x.send("Очистить поле");
    assert.match(denied.text,/Сначала измените предпочтительный способ связи/);
    assert.equal(x.db.findParticipantByTelegramId(userId).email,"ok@example.invalid");
    assert.equal(x.db.findParticipantByTelegramId(userId).preferred_contact,"Электронная почта");
    await x.send("Отмена"); await x.send("✏️ Изменить данные"); await x.send("Предпочтительный способ связи"); await x.send("Telegram");
    assert.equal(x.db.findParticipantByTelegramId(userId).preferred_contact,"Telegram");
    await x.send("✏️ Изменить данные"); await x.send("Электронная почта"); await x.send("Очистить поле");
    assert.equal(x.db.findParticipantByTelegramId(userId).email,null);
    assert.equal(x.db.findParticipantByTelegramId(userId).preferred_contact,"Telegram");
  } finally {x.close();}
});



