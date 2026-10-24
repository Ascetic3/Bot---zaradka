const DEFAULT_LIMITS = Object.freeze({
  command_start: { limit: 12, windowMs: 60_000 },
  command_myid: { limit: 6, windowMs: 60_000 },
  command_admin: { limit: 10, windowMs: 60_000 },
  registration_start: { limit: 4, windowMs: 5 * 60_000 },
  registration_continue: { limit: 30, windowMs: 60_000 },
  registration_save: { limit: 3, windowMs: 5 * 60_000 },
  admin_search: { limit: 10, windowMs: 60_000 },
  admin_page: { limit: 30, windowMs: 60_000 },
  statistics: { limit: 10, windowMs: 60_000 },
  excel: { limit: 1, windowMs: 5 * 60_000 },
  excel_confirm: { limit: 3, windowMs: 5 * 60_000 },
  preview: { limit: 5, windowMs: 5 * 60_000 },
  preview_continue: { limit: 30, windowMs: 60_000 },
  profile_edit: { limit: 12, windowMs: 60_000 },
  account_links: { limit: 10, windowMs: 60_000 },
  account_link_decision: { limit: 6, windowMs: 60_000 },
  participant_data: { limit: 6, windowMs: 5 * 60_000 }
});

const ENV_LIMITS = Object.freeze({
  command_start: ["BOT_LIMIT_START_PER_MINUTE", 60_000],
  command_myid: ["BOT_LIMIT_MYID_PER_MINUTE", 60_000],
  command_admin: ["BOT_LIMIT_ADMIN_COMMAND_PER_MINUTE", 60_000],
  registration_start: ["BOT_LIMIT_REGISTRATION_START_PER_5_MINUTES", 5 * 60_000],
  registration_continue: ["BOT_LIMIT_REGISTRATION_ANSWERS_PER_MINUTE", 60_000],
  registration_save: ["BOT_LIMIT_REGISTRATION_SAVE_PER_5_MINUTES", 5 * 60_000],
  admin_search: ["BOT_LIMIT_ADMIN_SEARCH_PER_MINUTE", 60_000],
  admin_page: ["BOT_LIMIT_ADMIN_PAGES_PER_MINUTE", 60_000],
  statistics: ["BOT_LIMIT_STATISTICS_PER_MINUTE", 60_000],
  excel: ["BOT_LIMIT_EXCEL_PER_5_MINUTES", 5 * 60_000],
  excel_confirm: ["BOT_LIMIT_EXCEL_CONFIRM_PER_5_MINUTES", 5 * 60_000],
  preview: ["BOT_LIMIT_PREVIEW_PER_5_MINUTES", 5 * 60_000],
  preview_continue: ["BOT_LIMIT_PREVIEW_ANSWERS_PER_MINUTE", 60_000],
  profile_edit: ["BOT_LIMIT_PROFILE_EDIT_PER_MINUTE", 60_000],
  account_links: ["BOT_LIMIT_ACCOUNT_LINKS_PER_MINUTE", 60_000],
  account_link_decision: ["BOT_LIMIT_ACCOUNT_LINK_DECISIONS_PER_MINUTE", 60_000],
  participant_data: ["BOT_LIMIT_PARTICIPANT_DATA_PER_5_MINUTES", 5 * 60_000]
});

function readRateLimitsFromEnvironment(env = process.env) {
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([action, policy]) => [action, { ...policy }]));
  for (const [action, [name]] of Object.entries(ENV_LIMITS)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(String(raw))) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 1 && value <= 10_000) limits[action].limit = value;
  }
  return limits;
}

function createRateLimiter({ limits = readRateLimitsFromEnvironment(), now = Date.now, cleanupIntervalMs = 60_000, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  const cleanup = () => {
    const timestamp = now();
    for (const [key, data] of entries) {
      const policy = limits[data.action];
      if (!policy || timestamp - data.timestamps.at(-1) >= policy.windowMs) entries.delete(key);
      else {
        data.timestamps = data.timestamps.filter((value) => timestamp - value < policy.windowMs);
        if (!data.timestamps.length) entries.delete(key);
      }
    }
  };
  const timer = cleanupIntervalMs > 0 ? setInterval(cleanup, cleanupIntervalMs) : null;
  timer?.unref?.();

  return {
    consume(telegramId, action) {
      const policy = limits[action];
      if (!policy || !Number.isInteger(policy.limit) || policy.limit < 1 || !Number.isFinite(policy.windowMs) || policy.windowMs < 1) {
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const key = `${String(telegramId)}:${action}`;
      const timestamp = now();
      const data = entries.get(key) || { action, timestamps: [] };
      data.timestamps = data.timestamps.filter((value) => timestamp - value < policy.windowMs);
      if (data.timestamps.length >= policy.limit) {
        entries.set(key, data);
        const retryAfterSeconds = Math.max(1, Math.ceil((policy.windowMs - (timestamp - data.timestamps[0])) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      data.timestamps.push(timestamp);
      entries.delete(key);
      entries.set(key, data);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    cleanup,
    stop() { if (timer) clearInterval(timer); },
    get size() { return entries.size; }
  };
}

async function allowRequest(ctx, limiter, action) {
  if (!ctx.from || !limiter) return true;
  const result = limiter.consume(ctx.from.id, action);
  if (result.allowed) return true;
  await ctx.reply(`Слишком много запросов. Попробуйте снова через ${result.retryAfterSeconds} сек.`);
  return false;
}

module.exports = { DEFAULT_LIMITS, ENV_LIMITS, readRateLimitsFromEnvironment, createRateLimiter, allowRequest };
