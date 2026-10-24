const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const modulePath = path.resolve(__dirname, "../src/database/index.js");
function isolatedDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-morning-"));
  const file = path.join(dir, "test.sqlite");
  const run = (script) => spawnSync(process.execPath, ["-e", script], { env: { ...process.env, DB_PATH: file, MODULE_PATH: modulePath }, encoding: "utf8" });
  try { fn({ file, run }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const create = (db) => db.addParticipant({ first_name: "Тест", last_name: "Участник", phone: "+79001234567", personal_data_consent: true });
test("участник, поиск по телефону и Telegram ID, обновление, аккаунты и конфликт телефона", () => isolatedDb(({run}) => {
  const result = run(`const d=require(process.env.MODULE_PATH); const p=d.addParticipant({first_name:'Тест',phone:'+79001234567'},{platform:'telegram',messenger_user_id:'test-user-1'}); if(!d.findParticipantByPhone('+79001234567')) process.exit(2); if(!d.findParticipantByTelegramId('test-user-1')) process.exit(3); d.updateParticipant(p.id,{city:'Тестоград'}); if(d.getParticipant(p.id).city!=='Тестоград') process.exit(4); d.linkAccount(p.id,'max','test-max-1'); try{d.addParticipant({first_name:'Другой',phone:'+79001234567'});process.exit(5)}catch(e){if(!String(e).includes('UNIQUE')) process.exit(6)} d.closeDatabase();`);
  assert.equal(result.status, 0, result.stderr);
}));
test("черновик сохраняется, удаляется и переживает повторное открытие базы", () => isolatedDb(({run}) => {
  let result=run(`const d=require(process.env.MODULE_PATH); d.saveDraft('telegram','test-user-2','phone',{first_name:'Тест'}); d.closeDatabase();`); assert.equal(result.status,0,result.stderr);
  result=run(`const d=require(process.env.MODULE_PATH); const x=d.getDraft('telegram','test-user-2'); if(x.answers.first_name!=='Тест')process.exit(2); if(!d.deleteDraft('telegram','test-user-2'))process.exit(3); d.closeDatabase();`); assert.equal(result.status,0,result.stderr);
}));
test("нельзя привязать чужой аккаунт; несколько платформ можно связать с участником", () => isolatedDb(({run}) => {
  const result=run(`const d=require(process.env.MODULE_PATH); const a=d.addParticipant({first_name:'A',phone:'+79001234567'}); const b=d.addParticipant({first_name:'B',phone:'+79001234568'}); d.linkAccount(a.id,'telegram','test-user-3'); d.linkAccount(a.id,'max','test-user-3'); try{d.linkAccount(b.id,'telegram','test-user-3');process.exit(2)}catch(e){} if(d.getParticipantCount()!==2)process.exit(3); d.closeDatabase();`); assert.equal(result.status,0,result.stderr);
}));

