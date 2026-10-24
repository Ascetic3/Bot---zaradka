const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");
function setup(ownerId="10001") {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"magic-admin-")); process.env.DB_PATH=path.join(dir,"admins.sqlite"); process.env.OWNER_TELEGRAM_ID=ownerId;
  delete require.cache[require.resolve("../src/database")]; delete require.cache[require.resolve("../src/admin")];
  const db=require("../src/database"); const bot=new Bot("123456:ADMIN_TEST_ONLY",{botInfo:{id:123456,is_bot:true,first_name:"Test",username:"test_bot"}});
  require("../src/admin").registerAdmin(bot); const sent=[]; bot.api.config.use(async (_prev,method,payload)=>{if(method!=="sendMessage")throw new Error(`Unexpected API: ${method}`);sent.push(payload);return {ok:true,result:{message_id:sent.length,date:1,chat:{id:payload.chat_id,type:"private"},text:payload.text,reply_markup:payload.reply_markup}};});
  let updateId=0; async function send(text,id=10001,type="private",command=false){const chatId=type==="private"?id:-555;await bot.handleUpdate({update_id:++updateId,message:{message_id:updateId,date:1,chat:{id:chatId,type},from:{id,is_bot:false,first_name:"Test"},...(command?{entities:[{type:"bot_command",offset:0,length:text.length}]}:{}),text}});return sent.at(-1);}
  return {db,send,sent,close(){db.closeDatabase();fs.rmSync(dir,{recursive:true,force:true});delete process.env.DB_PATH;delete process.env.OWNER_TELEGRAM_ID;}};
}
test("владелец получает меню и видит управление администраторами",async()=>{const x=setup();try{assert.equal(x.db.getAdminRole("10001"),"owner");const m=await x.send("/admin",10001,"private",true);assert.match(m.text,/Административное меню/);assert.match(JSON.stringify(x.sent.at(-1)),/Управление администраторами/);}finally{x.close();}});
test("администратор видит разрешённые действия, но не управление ролями",async()=>{const x=setup();try{x.db.addAdmin("20002");const m=await x.send("/admin",20002,"private",true);assert.match(m.text,/Административное меню/);assert.doesNotMatch(JSON.stringify(x.sent.at(-1)),/Управление администраторами/);assert.match((await x.send("📊 Статистика",20002)).text,/Всего участников: 0/);}finally{x.close();}});
test("обычный пользователь не получает доступ к /admin",async()=>{const x=setup();try{assert.match((await x.send("/admin",30003,"private",true)).text,/нет доступа/);}finally{x.close();}});
test("администратор не может открыть или выполнить управление администраторами",async()=>{const x=setup();try{x.db.addAdmin("20002");assert.match((await x.send("⚙️ Управление администраторами",20002)).text,/Только владелец/);assert.equal(x.db.getAdminRole("40004"),null);}finally{x.close();}});
test("владелец добавляет и удаляет администратора по Telegram ID",async()=>{const x=setup();try{await x.send("➕ Добавить администратора");assert.match((await x.send("20002")).text,/добавлен/);assert.equal(x.db.getAdminRole("20002"),"admin");await x.send("➖ Удалить администратора");assert.match((await x.send("20002")).text,/удалён/);assert.equal(x.db.getAdminRole("20002"),null);}finally{x.close();}});
test("владелец не может добавить или удалить самого себя, и владелец не удаляется из базы",async()=>{const x=setup();try{await x.send("➕ Добавить администратора");assert.match((await x.send("10001")).text,/самого себя/);assert.equal(x.db.getAdminRole("10001"),"owner");assert.equal(x.db.removeAdmin("10001"),false);assert.equal(x.db.getAdminRole("10001"),"owner");}finally{x.close();}});
test("групповой чат не получает административное меню или функции",async()=>{const x=setup();try{assert.match((await x.send("/admin",10001,"group",true)).text,/только в личном чате/);assert.match((await x.send("📊 Статистика",10001,"group")).text,/только в личном чате/);}finally{x.close();}});
test("если OWNER_TELEGRAM_ID не задан, административные права никому не выдаются",async()=>{const x=setup("");try{assert.equal(x.db.getAdminRole("10001"),null);assert.match((await x.send("/admin",10001,"private",true)).text,/нет доступа/);}finally{x.close();}});






