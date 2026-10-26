const { createMeetingBroadcastStore } = require("./meeting-broadcast-store");
const { createMeetingBroadcastScheduler } = require("./meeting-broadcast-service");

// Shared composition point used by the real bot entry point and integration tests.
function createMeetingBroadcastRuntime({ database, telegramApi, demoMode = false, demoAdminIds = [], ...schedulerOptions }) {
  if (!database?.db || typeof database.getAdminRole !== "function") {
    throw new Error("Для планировщика рассылок не настроена база данных.");
  }
  if (typeof telegramApi?.sendMessage !== "function") {
    throw new Error("Для планировщика рассылок не настроен Telegram API.");
  }
  return createMeetingBroadcastScheduler({
    store: createMeetingBroadcastStore(database.db),
    adapters: { telegram: telegramApi },
    getAdminRole: database.getAdminRole,
    demoMode,
    demoAdminIds,
    ...schedulerOptions
  });
}

module.exports = { createMeetingBroadcastRuntime };

