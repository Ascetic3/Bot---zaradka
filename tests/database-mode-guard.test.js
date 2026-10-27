const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { assertDatabaseMode } = require("../src/database/config");
const { initializeEmptyDatabase, CURRENT_SCHEMA_VERSION } = require("../src/database/migrations");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magic-db-mode-"));
  const data = path.join(root, "data"); fs.mkdirSync(data);
  const production = path.join(data, "club.sqlite");
  const demo = path.join(data, "demo.sqlite");
  const work = new Database(production); initializeEmptyDatabase(work);
  work.prepare("INSERT INTO admins(telegram_id,role,added_at) VALUES('777000001','owner','2026-01-01T00:00:00.000Z')").run(); work.close();
  fs.copyFileSync(production, demo);
  const sample = new Database(demo); sample.exec("CREATE TABLE demo_seed_metadata(seed_name TEXT PRIMARY KEY,seed_version INTEGER NOT NULL,seeded_at TEXT NOT NULL,participant_count INTEGER NOT NULL);");
  sample.prepare("INSERT INTO demo_seed_metadata VALUES('magic-morning-demo',1,'2026-01-01T00:00:00.000Z',150)").run(); sample.close();
  return { root, production, demo, data, close() { fs.rmSync(root,{recursive:true,force:true}); } };
}
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("режимы разрешают только ожидаемый тип существующей базы", () => {
  const x=fixture(); try {
    assert.equal(assertDatabaseMode(x.production,{demoMode:"false",projectRoot:x.root}).type,"production");
    assert.equal(assertDatabaseMode(x.demo,{demoMode:"true",projectRoot:x.root}).type,"demo");
    assert.throws(()=>assertDatabaseMode(x.demo,{demoMode:"false",projectRoot:x.root}),/демонстрационную базу/i);
    assert.throws(()=>assertDatabaseMode(x.production,{demoMode:"true",projectRoot:x.root}),/DB_PATH должен указывать/i);
  } finally { x.close(); }
});

test("обычный режим отказывается от отсутствующей базы и не создаёт файл", () => {
  const x=fixture(); const missing=path.join(x.data,"mistyped-path.sqlite");
  try {
    assert.throws(()=>assertDatabaseMode(missing,{demoMode:"false",projectRoot:x.root}),/рабочая SQLite-база не найдена.*не создана/i);
    assert.equal(fs.existsSync(missing),false);
  } finally { x.close(); }
});

test("обычный режим отклоняет существующий пустой или несовместимый файл без изменений", () => {
  const x=fixture(); const wrong=path.join(x.data,"wrong-existing.sqlite");
  const db=new Database(wrong); db.close(); const before=hash(wrong);
  try {
    assert.throws(()=>assertDatabaseMode(wrong,{demoMode:"false",projectRoot:x.root}),/схема SQLite v11/i);
    assert.equal(hash(wrong),before);
    assert.equal(fs.existsSync(wrong),true);
  } finally { x.close(); }
});

test("демобаза запрещена обычному режиму после переименования или через альтернативный путь", () => {
  const x=fixture(); try {
    const renamed=path.join(x.data,"club-renamed.sqlite"); fs.copyFileSync(x.demo,renamed);
    assert.throws(()=>assertDatabaseMode(renamed,{demoMode:"false",projectRoot:x.root}),/служебные метаданные демобазы/i);
    const aliasDirectory=path.join(x.data,"alias-directory"); fs.mkdirSync(aliasDirectory);
    const alias=path.join(aliasDirectory,"..","demo.sqlite");
    const before=hash(x.demo);
    assert.throws(()=>assertDatabaseMode(alias,{demoMode:"false",projectRoot:x.root}),/демонстрационную базу/i);
    assert.equal(hash(x.demo),before);
  } finally { x.close(); }
});

test("точка входа отклоняет демобазу до импорта пишущего модуля и до polling", () => {
  const x=fixture(); try {
    const before=hash(x.demo);
    const script="process.env.BOT_TOKEN='';process.env.DB_PATH=process.argv[1];process.env.DEMO_MODE='false';require('./src/bot.js')";
    const result=spawnSync(process.execPath,["-e",script,x.demo],{cwd:path.resolve(__dirname,".."),encoding:"utf8",timeout:10000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/обычный режим остановлен.*демобазы/i);
    assert.doesNotMatch(result.stderr,/Не задан BOT_TOKEN/);
    assert.equal(hash(x.demo),before);
  } finally { x.close(); }
});

test("точка входа пропускает корректную рабочую базу к обычной проверке токена", () => {
  const x=fixture(); try {
    const script="process.env.BOT_TOKEN='';process.env.DB_PATH=process.argv[1];process.env.DEMO_MODE='false';require('./src/bot.js')";
    const result=spawnSync(process.execPath,["-e",script,x.production],{cwd:path.resolve(__dirname,".."),encoding:"utf8",timeout:10000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/Не задан BOT_TOKEN/);
    assert.doesNotMatch(result.stderr,/Запуск остановлен:.*DB_PATH/);
  } finally { x.close(); }
});

test("точка входа останавливается на отсутствующем DB_PATH до импорта grammY и не создаёт базу", () => {
  const x=fixture(); const missing=path.join(x.data,"missing-production.sqlite");
  try {
    const script = `const Module=require('node:module');const original=Module._load;Module._load=function(request,...args){if(request==='grammy'){process.stderr.write('GRAMMY_MODULE_REACHED');throw new Error('polling must not start')}return original.call(this,request,...args)};process.env.BOT_TOKEN='test-token';process.env.DB_PATH=process.argv[1];process.env.DEMO_MODE='false';require('./src/bot.js')`;
    const result=spawnSync(process.execPath,["-e",script,missing],{cwd:path.resolve(__dirname,".."),encoding:"utf8",timeout:10000});
    assert.equal(result.status,1);
    assert.match(result.stderr,/рабочая SQLite-база не найдена/i);
    assert.doesNotMatch(result.stderr,/GRAMMY_MODULE_REACHED|polling must not start/);
    assert.equal(fs.existsSync(missing),false);
  } finally { x.close(); }
});

test("явная инициализация по-прежнему создаёт новую схему v11 в выбранном временном файле", () => {
  const x=fixture(); const explicit=path.join(x.data,"explicitly-created.sqlite");
  try {
    assert.equal(fs.existsSync(explicit),false);
    const db=new Database(explicit);
    try { initializeEmptyDatabase(db); assert.equal(db.pragma("user_version",{simple:true}),CURRENT_SCHEMA_VERSION); }
    finally { db.close(); }
    assert.equal(assertDatabaseMode(explicit,{demoMode:"false",projectRoot:x.root}).type,"production");
  } finally { x.close(); }
});

