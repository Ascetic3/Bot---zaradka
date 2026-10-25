const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const modulePath = path.resolve(__dirname, "../src/database/index.js");

function isolatedRun(script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-account-link-"));
  const file = path.join(directory, "links.sqlite");
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, DB_PATH: file, MODULE_PATH: modulePath },
      encoding: "utf8",
      timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("повторная привязка идемпотентна, конфликт участника явный, Telegram и MAX разделены", () => {
  isolatedRun(`
    const assert = require('node:assert/strict');
    const d = require(process.env.MODULE_PATH);
    const a = d.addParticipant({first_name:'Вымышленный А', phone:'+79001110001'});
    const b = d.addParticipant({first_name:'Вымышленный Б', phone:'+79001110002'});
    const first = d.linkAccount(a.id, 'telegram', '700000001');
    const repeated = d.linkAccount(a.id, 'telegram', '700000001');
    assert.equal(repeated.id, first.id);
    assert.throws(() => d.linkAccount(b.id, 'telegram', '700000001'), error => error.code === 'ACCOUNT_LINK_CONFLICT');
    assert.throws(() => d.linkAccount(a.id, 'telegram', '700000002'), error => error.code === 'ACCOUNT_LINK_CONFLICT');
    const max = d.linkAccount(b.id, 'max', '700000001');
    assert.equal(max.participant_id, b.id);
    assert.equal(d.db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 2);
    d.closeDatabase();
  `);
});

test("два SQLite-подключения одновременно не могут присвоить аккаунт разным участникам", () => {
  isolatedRun(`
    const assert = require('node:assert/strict');
    const { Worker } = require('node:worker_threads');
    const BetterSqlite3 = require('better-sqlite3');
    const d = require(process.env.MODULE_PATH);
    const a = d.addParticipant({first_name:'Синтетический А', phone:'+79002220001'});
    const b = d.addParticipant({first_name:'Синтетический Б', phone:'+79002220002'});
    const participantIds = [a.id, b.id];
    d.closeDatabase();

    const source = \`
      const { parentPort, workerData } = require('node:worker_threads');
      process.env.DB_PATH = workerData.file;
      const database = require(workerData.modulePath);
      parentPort.postMessage({ ready: true });
      parentPort.once('message', () => {
        try {
          const account = database.linkAccount(workerData.participantId, 'telegram', '700000010');
          parentPort.postMessage({ ok: true, participant_id: account.participant_id });
        } catch (error) {
          parentPort.postMessage({ ok: false, code: error.code || null, name: error.name });
        } finally {
          database.closeDatabase();
        }
      });
    \`;
    function startWorker(participantId) {
      const worker = new Worker(source, { eval: true, workerData: { file: process.env.DB_PATH, modulePath: process.env.MODULE_PATH, participantId } });
      let readyResolve;
      let resultResolve;
      let resultReject;
      const ready = new Promise(resolve => { readyResolve = resolve; });
      const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      worker.on('message', message => message.ready ? readyResolve() : resultResolve(message));
      worker.on('error', resultReject);
      worker.on('exit', code => { if (code !== 0) resultReject(new Error('worker failed')); });
      return { worker, ready, result };
    }
    (async () => {
      const workers = participantIds.map(startWorker);
      await Promise.all(workers.map(item => item.ready));
      for (const item of workers) item.worker.postMessage('link now');
      const results = await Promise.all(workers.map(item => item.result));
      assert.equal(results.filter(item => item.ok).length, 1);
      assert.equal(results.filter(item => item.code === 'ACCOUNT_LINK_CONFLICT').length, 1);
      const winner = results.find(item => item.ok);
      const check = new BetterSqlite3(process.env.DB_PATH, { readonly: true });
      const accounts = check.prepare("SELECT participant_id FROM accounts WHERE platform='telegram' AND messenger_user_id='700000010'").all();
      assert.equal(accounts.length, 1);
      assert.equal(Number(accounts[0].participant_id), Number(winner.participant_id));
      check.close();
    })().catch(error => { console.error(error.stack); process.exitCode = 1; });
  `);
});

