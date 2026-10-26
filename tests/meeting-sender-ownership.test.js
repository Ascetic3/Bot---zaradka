const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const Database = require("better-sqlite3");
const { migrateDatabase } = require("../src/database/migrations");
const { createMeetingBroadcastStore } = require("../src/meeting-broadcast-store");
const { createMeetingBroadcastScheduler } = require("../src/meeting-broadcast-service");
const { runRecoveryCommand } = require("../src/database/recover-meeting-sender-cli");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-sender-owner-"));
  const file = path.join(directory, "test.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys=ON");
  migrateDatabase(db);
  db.prepare("INSERT INTO admins(telegram_id,role) VALUES('800001','owner')").run();
  const store = createMeetingBroadcastStore(db);
  function recipient(id) {
    const participant = db.prepare("INSERT INTO participants(first_name,phone,phone_confirmed_at,personal_data_consent,consent_at,consent_version) VALUES('Test',?,'2030-01-01T00:00:00.000Z',1,'2030-01-01T00:00:00.000Z','test')")
      .run("+79991" + String(id).slice(-6).padStart(6, "0")).lastInsertRowid;
    db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,'telegram',?)").run(participant, String(id));
    db.prepare("INSERT INTO telegram_private_chats VALUES(?,'2030-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z')").run(String(id));
    return Number(participant);
  }
  function draft() {
    const now = new Date();
    const id = store.createDraft({ title: "Test meeting", startsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      scheduledAt: new Date(now.getTime() - 1000).toISOString(), zoomUrl: "https://zoom.us/j/123456789",
      timezone: "Etc/UTC", createdBy: "800001", now: now.toISOString() });
    assert.equal(store.confirmDraft(id, "800001", now.toISOString()), true);
    return id;
  }
  return { directory, file, db, store, recipient, draft,
    close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function waitFor(worker, event, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for " + event)); }, timeoutMs);
    const onMessage = (message) => {
      if (message.event === "error") { cleanup(); reject(new Error(message.message)); }
      if (message.event === event) { cleanup(); resolve(message); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); }
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

test("право A остаётся эксклюзивным после COMMIT и во время API; B ждёт другую рассылку", async () => {
  const x = fixture();
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let a, b;
  try {
    x.recipient("900001");
    x.draft(); x.draft();
    const workerSource = [
      "const {parentPort,workerData}=require('node:worker_threads');",
      "const Database=require(workerData.databaseModule);",
      "const {createMeetingBroadcastStore}=require(workerData.storeModule);",
      "const {createMeetingBroadcastScheduler}=require(workerData.schedulerModule);",
      "const db=new Database(workerData.file,{timeout:5000});",
      "const store=createMeetingBroadcastStore(db);",
      "if(workerData.pauseAfterCommit){",
      " const reserve=store.reserveDeliverySend.bind(store);let paused=false;",
      " store.reserveDeliverySend=(...args)=>{const result=reserve(...args);",
      "   if(result.status==='reserved'&&!paused){paused=true;parentPort.postMessage({event:'slot'});",
      "     Atomics.wait(new Int32Array(workerData.gate),0,0,60000)}return result};",
      "}else{const reserve=store.reserveDeliverySend.bind(store);let waiting=false;",
      " store.reserveDeliverySend=(...args)=>{const result=reserve(...args);",
      "   if(result.status==='wait'&&!waiting){waiting=true;parentPort.postMessage({event:'waiting'})}return result};",
      "}",
      "let sends=0;const scheduler=createMeetingBroadcastScheduler({store,workerId:workerData.name,",
      " adapters:{telegram:{async sendMessage(){sends++;parentPort.postMessage({event:'apiStart',at:Date.now()});",
      "   await new Promise(resolve=>setTimeout(resolve,workerData.pauseAfterCommit?80:1));",
      "   parentPort.postMessage({event:'apiEnd',at:Date.now()})}}},getAdminRole:()=> 'owner'});",
      "(async()=>{for(let attempt=0;attempt<60;attempt++){await scheduler.tick();",
      " if(sends>0||workerData.pauseAfterCommit)break;await new Promise(resolve=>setTimeout(resolve,100))}",
      " if(sends===0)throw new Error('No delivery was sent after retries: '+JSON.stringify(db.prepare('SELECT id,status,lease_owner,lease_until,last_error_code FROM meeting_broadcasts').all())+' owner='+JSON.stringify(store.getSenderState()));",
      " parentPort.postMessage({event:'done'});db.close()})()",
      " .catch(error=>{parentPort.postMessage({event:'error',message:error.message});db.close()});"
    ].join("\n");
    const common = { file: x.file, gate: gate.buffer, databaseModule: require.resolve("better-sqlite3"),
      storeModule: require.resolve("../src/meeting-broadcast-store"),
      schedulerModule: require.resolve("../src/meeting-broadcast-service") };
    a = new Worker(workerSource, { eval: true, workerData: { ...common, name: "owner-a", pauseAfterCommit: true } });
    const aDone = waitFor(a, "done");
    await waitFor(a, "slot");
    b = new Worker(workerSource, { eval: true, workerData: { ...common, name: "owner-b", pauseAfterCommit: false } });
    const bDone = waitFor(b, "done");
    const bWaiting = waitFor(b, "waiting");
    const aStart = waitFor(a, "apiStart");
    const aEnd = waitFor(a, "apiEnd");
    const bStart = waitFor(b, "apiStart");
    await bWaiting;
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_deliveries WHERE status='sending'").get().n, 1);
    assert.ok(x.store.getSenderState().sender_token);
    gate[0] = 1; Atomics.notify(gate, 0);
    const [startA, endA, startB] = await Promise.all([aStart, aEnd, bStart]);
    await Promise.all([aDone, bDone]);
    assert.ok(startA.at <= endA.at);
    assert.ok(startB.at - endA.at >= 50, "the next API call starts after the prior call and shared pause");
    assert.equal(x.store.getSenderState().sender_token, null);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_deliveries WHERE status='sent'").get().n, 2);
  } finally {
    gate[0] = 1; Atomics.notify(gate, 0);
    if (a) await a.terminate();
    if (b) await b.terminate();
    x.close();
  }
});

test("429 сохраняет общую паузу до освобождения владельца", async () => {
  const x = fixture();
  const second = new Database(x.file);
  try {
    x.recipient("900001");
    const firstId = x.draft();
    const storeB = createMeetingBroadcastStore(second);
    let time = new Date();
    const starts = [];
    let first = true;
    const api = { async sendMessage() {
      starts.push(time.getTime());
      if (first) { first = false; throw { error_code: 429, parameters: { retry_after: 9 } }; }
    } };
    const options = { adapters: { telegram: api }, getAdminRole: () => "owner", now: () => time,
      sleep: async (ms) => { time = new Date(time.getTime() + ms); }, minSendIntervalMs: 50 };
    const a = createMeetingBroadcastScheduler({ ...options, store: x.store, workerId: "429-a" });
    const b = createMeetingBroadcastScheduler({ ...options, store: storeB, workerId: "429-b" });
    await a.tick();
    const blockedUntil = Date.parse(x.store.getSenderState().blocked_until);
    assert.ok(blockedUntil >= starts[0] + 9000);
    assert.equal(x.store.getSenderState().sender_token, null);
    assert.equal(x.store.summary(firstId).deliveries.temporary_error, 1);
    const secondId = x.draft();
    await b.tick();
    assert.ok(starts.slice(1).every((at) => at >= blockedUntil));
    assert.equal(storeB.summary(secondId).deliveries.sent, 1);
    assert.equal(x.store.summary(firstId).deliveries.sent, 1);
  } finally { second.close(); x.close(); }
});

test("истечение аренды задания во время API не снимает право живого отправителя", async () => {
  const x = fixture();
  const second = new Database(x.file);
  try {
    x.recipient("900001");
    const id = x.draft();
    let time = new Date();
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const api = { async sendMessage() {
      entered();
      await new Promise((resolve) => { release = resolve; });
    } };
    const a = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: api },
      getAdminRole: () => "owner", now: () => time, leaseMs: 1000, workerId: "lease-a" });
    const running = a.tick();
    await started;
    time = new Date(time.getTime() + 2000);
    const other = createMeetingBroadcastStore(second);
    assert.equal(other.claimNext(time.toISOString(), "lease-b", 1000), null);
    assert.ok(x.store.getSenderState().sender_token);
    release();
    await running;
    assert.equal(x.store.summary(id).deliveries.sent, 1);
    assert.equal(x.store.get(id).status, "completed");
    assert.equal(x.store.getSenderState().sender_token, null);
  } finally { second.close(); x.close(); }
});

test("погибший владелец восстанавливается только после завершения процесса; доставка uncertain", async () => {
  const x = fixture();
  let child;
  try {
    x.recipient("900001");
    const id = x.draft();
    const source = [
      "const Database=require(process.argv[2]);",
      "const {createMeetingBroadcastStore}=require(process.argv[3]);",
      "const db=new Database(process.argv[1],{timeout:5000});",
      "const store=createMeetingBroadcastStore(db),now=new Date().toISOString();",
      "const job=store.claimNext(now,'crash-owner',60000);store.ensureRecipients(job.id);",
      "const delivery=store.nextDeliveries(job.id,now)[0];",
      "const right=store.reserveDeliverySend(delivery,now,60000,job.id,'crash-owner');",
      "if(right.status!=='reserved')process.exit(3);",
      "process.stdout.write('READY\\n');setInterval(()=>{},1000);"
    ].join("\n");
    child = spawn(process.execPath, ["-e", source, x.file, require.resolve("better-sqlite3"),
      require.resolve("../src/meeting-broadcast-store")], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Crash owner did not acquire the right")), 10_000);
      child.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        if (String(chunk).includes("READY")) resolve(); else reject(new Error("Owner did not become ready"));
      });
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error("Owner exited before ready: " + code)); });
    });
    const owner = runRecoveryCommand({ mode: "check", databasePath: x.file });
    assert.equal(owner.pid, child.pid);
    assert.throws(() => runRecoveryCommand({ mode: "apply", databasePath: x.file,
      confirmation: x.file, ownerPid: child.pid }), /ещё работает/);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    assert.equal(child.kill(), true);
    await exited;
    const recovered = runRecoveryCommand({ mode: "apply", databasePath: x.file,
      confirmation: x.file, ownerPid: child.pid });
    assert.equal(recovered.deliveryStatus, "uncertain");
    assert.equal(x.store.summary(id).deliveries.uncertain, 1);
    assert.equal(x.store.get(id).status, "failed");
    assert.equal(x.store.getSenderState().sender_token, null);
    assert.equal(runRecoveryCommand({ mode: "check", databasePath: x.file }).active, false);
  } finally { if (child && child.exitCode === null) child.kill(); x.close(); }
});

test("отмена и изменение допуска во время ожидания права не начинают API", async () => {
  for (const scenario of ["cancel", "withdraw", "delete", "demo_role"]) {
    const x = fixture();
    try {
      const demo = scenario === "demo_role";
      if (demo) {
        x.db.prepare("INSERT INTO admins(telegram_id,role) VALUES('800002','admin')").run();
        for (const id of ["800001", "800002"]) x.db.prepare("INSERT INTO telegram_private_chats VALUES(?,'2030-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z')").run(id);
      } else {
        x.recipient("900001");
        x.recipient("900002");
      }
      const id = x.draft();
      let time = new Date();
      const calls = [];
      let changed = false;
      const scheduler = createMeetingBroadcastScheduler({ store: x.store, demoMode: demo,
        demoAdminIds: demo ? ["800001", "800002"] : [], minSendIntervalMs: 50,
        adapters: { telegram: { async sendMessage(chatId) { calls.push(String(chatId)); } } },
        getAdminRole: () => "owner", now: () => time,
        sleep: async (ms) => {
          if (!changed) {
            changed = true;
            if (scenario === "cancel") x.store.requestStop(id, time.toISOString());
            if (scenario === "withdraw") x.db.prepare("UPDATE participants SET consent_withdrawn_at=? WHERE id=2").run(time.toISOString());
            if (scenario === "delete") x.db.prepare("DELETE FROM participants WHERE id=2").run();
            if (scenario === "demo_role") x.db.prepare("DELETE FROM admins WHERE telegram_id='800002'").run();
          }
          time = new Date(time.getTime() + ms);
        } });
      await scheduler.tick();
      assert.equal(changed, true, scenario);
      assert.equal(calls.length, 1, scenario);
      if (scenario === "cancel") assert.equal(x.store.get(id).status, "cancelled");
      else assert.equal(x.store.summary(id).deliveries.unavailable, 1);
      assert.equal(x.store.getSenderState().sender_token, null);
    } finally { x.close(); }
  }
});

