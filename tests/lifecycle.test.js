const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateTracker, createGracefulShutdown, installSignalHandlers } = require("../src/lifecycle");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("graceful shutdown stops intake and closes SQLite only after polling, active updates and background work drain", async () => {
  const tracker = createUpdateTracker();
  const update = deferred();
  const backup = deferred();
  let closed = 0;
  let stopped = 0;
  let exitCode;
  let entered = false;
  const activeUpdate = tracker.middleware({}, async () => { entered = true; await update.promise; });
  await Promise.resolve();
  assert.equal(entered, true);
  const polling = deferred();
  const lifecycle = createGracefulShutdown({
    bot: { stop: async () => { stopped += 1; } },
    database: { closeDatabase: () => { closed += 1; } },
    tracker,
    stopBackground: () => backup.promise,
    getPollingPromise: () => polling.promise,
    setExitCode: (code) => { exitCode = code; },
    forceExit: () => assert.fail("Неожиданное аварийное завершение"),
    timeoutMs: 1_000
  });
  const first = lifecycle.shutdown("SIGTERM");
  const second = lifecycle.shutdown("SIGINT");
  assert.equal(first, second);
  assert.equal(tracker.accepting, false);
  assert.equal(tracker.active, 1);
  await tracker.middleware({}, async () => assert.fail("Новые обработчики не должны запускаться"));
  assert.equal(closed, 0);
  update.resolve();
  backup.resolve();
  polling.resolve();
  await Promise.all([activeUpdate, first]);
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  assert.equal(exitCode, 143);
});

test("ошибка остановки безопасно записывается, установка кода завершения — ненулевой", async () => {
  const logs = [];
  let closed = 0;
  let code;
  const lifecycle = createGracefulShutdown({
    bot: { stop: async () => { throw new Error("message with PII and token"); } },
    database: { closeDatabase: () => { closed += 1; } },
    getPollingPromise: () => Promise.resolve(),
    setExitCode: (value) => { code = value; },
    logger: { error: (line) => logs.push(line) },
    forceExit: () => assert.fail("Неожиданное аварийное завершение"),
    timeoutMs: 500
  });
  const result = await lifecycle.shutdown("SIGTERM");
  assert.equal(result.timedOut, false);
  assert.equal(closed, 1);
  assert.equal(code, 1);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /PII|token|message with/);
  assert.match(logs[0], /shutdown_step_failed/);
});

test("ошибка запуска polling безопасно завершается кодом 1", async () => {
  const logs = [];
  let closed = 0;
  let code;
  const startupError = Object.assign(new Error("PII and bot-token payload"), { name: "GrammyError", error_code: 401 });
  const lifecycle = createGracefulShutdown({
    bot: { stop: async () => {} },
    database: { closeDatabase: () => { closed += 1; } },
    getPollingPromise: () => Promise.reject(startupError),
    setExitCode: (value) => { code = value; },
    logger: { error: (line) => logs.push(line) },
    forceExit: () => assert.fail("Неожиданное аварийное завершение"),
    timeoutMs: 500
  });
  const result = await lifecycle.shutdown("startup_error");
  assert.equal(result.timedOut, false);
  assert.equal(code, 1);
  assert.equal(closed, 1);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /PII|token|payload|401/);
});

test("SIGINT устанавливает ожидаемый код завершения", async () => {
  let code;
  const lifecycle = createGracefulShutdown({
    bot: { stop: async () => {} }, database: { closeDatabase() {} },
    getPollingPromise: () => Promise.resolve(), setExitCode: (value) => { code = value; },
    forceExit: () => assert.fail("Неожиданное аварийное завершение"), timeoutMs: 500
  });
  await lifecycle.shutdown("SIGINT");
  assert.equal(code, 130);
});

test("тайм-аут не закрывает SQLite, пока операция может её использовать", async () => {
  let closed = 0;
  let forced = 0;
  let code;
  const lifecycle = createGracefulShutdown({
    bot: { stop: async () => {} },
    database: { closeDatabase: () => { closed += 1; } },
    stopBackground: () => new Promise(() => {}),
    setExitCode: (value) => { code = value; },
    forceExit: (value) => { forced = value; },
    logger: { error() {} },
    timeoutMs: 10
  });
  const result = await lifecycle.shutdown("SIGTERM");
  assert.equal(result.timedOut, true);
  assert.equal(closed, 0);
  assert.equal(forced, 1);
  assert.equal(code, 1);
});

test("обработчики сигналов можно установить и снять, повторный сигнал идемпотентен", async () => {
  const emitter = new EventEmitter();
  const calls = [];
  const lifecycle = { shutdown: async (signal) => { calls.push(signal); } };
  const remove = installSignalHandlers(lifecycle, emitter);
  emitter.emit("SIGINT");
  emitter.emit("SIGTERM");
  await Promise.resolve();
  assert.deepEqual(calls, ["SIGINT", "SIGTERM"]);
  remove();
  assert.equal(emitter.listenerCount("SIGINT"), 0);
  assert.equal(emitter.listenerCount("SIGTERM"), 0);
});
