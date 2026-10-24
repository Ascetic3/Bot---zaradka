function createUpdateTracker() {
  let accepting = true;
  let active = 0;
  let idleResolvers = [];
  return {
    middleware(_ctx, next) {
      if (!accepting) return undefined;
      active += 1;
      return Promise.resolve().then(next).finally(() => {
        active -= 1;
        if (active === 0) {
          const resolvers = idleResolvers;
          idleResolvers = [];
          for (const resolve of resolvers) resolve();
        }
      });
    },
    stopAccepting() { accepting = false; },
    get accepting() { return accepting; },
    get active() { return active; },
    waitForIdle() { return active === 0 ? Promise.resolve() : new Promise((resolve) => idleResolvers.push(resolve)); }
  };
}

function errorType(error) {
  const allowed = new Set(["Error", "TypeError", "RangeError", "AbortError", "GrammyError", "HttpError", "SqliteError"]);
  return allowed.has(error?.name) ? error.name : "Error";
}

function createGracefulShutdown({
  bot,
  database,
  tracker = createUpdateTracker(),
  stopBackground = async () => {},
  cleanup = async () => {},
  getPollingPromise = () => null,
  setExitCode = (code) => { process.exitCode = code; },
  forceExit = (code) => process.exit(code),
  logger = console,
  timeoutMs = 30_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  let shutdownPromise = null;
  let stopping = false;

  function logFailure(stage, error) {
    const detail = { event: "shutdown_step_failed", stage, error_type: errorType(error) };
    if (typeof error?.code === "string" && /^[A-Z0-9_]{1,48}$/.test(error.code)) detail.error_code = error.code;
    logger.error?.(JSON.stringify(detail));
  }

  function run(reason = "SIGTERM") {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    tracker.stopAccepting();
    shutdownPromise = (async () => {
      const outcomes = [];
      const safely = async (stage, operation) => {
        try { return await operation(); }
        catch (error) { outcomes.push({ stage, error }); logFailure(stage, error); return undefined; }
      };

      // Stop scheduling new work first. bot.stop() aborts polling; update tracking
      // and the polling promise ensure database closure happens only after work drains.
      const backgroundPromise = safely("background_stop", stopBackground);
      const botStopPromise = safely("bot_stop", () => bot.stop());
      const polling = Promise.resolve(getPollingPromise()).catch((error) => {
        outcomes.push({ stage: "polling", error });
        logFailure("polling", error);
      });
      const drainPromise = Promise.all([backgroundPromise, botStopPromise, polling, tracker.waitForIdle()]);

      let timeout;
      const timedOut = await Promise.race([
        drainPromise.then(() => false),
        new Promise((resolve) => { timeout = setTimeoutFn(() => resolve(true), timeoutMs); })
      ]);
      if (timeout) clearTimeoutFn(timeout);

      if (timedOut) {
        setExitCode(1);
        logger.error?.(JSON.stringify({ event: "shutdown_timeout", timeout_ms: timeoutMs }));
        // Never close SQLite while handlers or backups may still be using it.
        forceExit(1);
        return { timedOut: true, outcomes };
      }

      await safely("cleanup", cleanup);
      await safely("database_close", () => database.closeDatabase());
      const code = outcomes.length ? 1 : reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : reason === "startup_error" ? 1 : 0;
      setExitCode(code);
      return { timedOut: false, exitCode: code, outcomes };
    })();
    return shutdownPromise;
  }

  return {
    shutdown: run,
    get stopping() { return stopping; },
    get promise() { return shutdownPromise; }
  };
}

function installSignalHandlers(shutdown, emitter = process) {
  const onSigint = () => { void shutdown.shutdown("SIGINT"); };
  const onSigterm = () => { void shutdown.shutdown("SIGTERM"); };
  emitter.on("SIGINT", onSigint);
  emitter.on("SIGTERM", onSigterm);
  return () => {
    emitter.off?.("SIGINT", onSigint);
    emitter.off?.("SIGTERM", onSigterm);
  };
}

module.exports = { createUpdateTracker, createGracefulShutdown, installSignalHandlers };
