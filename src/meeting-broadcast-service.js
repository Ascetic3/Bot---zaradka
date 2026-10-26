const formatterCache = new Map();

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }));
  }
  return formatterCache.get(timeZone);
}

function validateClubTimeZone(timeZone) {
  const value = String(timeZone ?? "").trim();
  if (!value) throw new Error("Укажите часовой пояс клуба в .env: CLUB_TIMEZONE (например, Europe/Moscow).");
  try { formatterFor(value).format(new Date()); }
  catch { throw new Error("CLUB_TIMEZONE должен быть корректным часовым поясом IANA."); }
  return value;
}

function toUtcFromClubLocal(input, timeZone) {
  const local = String(input ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error("Введите дату и время как ГГГГ-ММ-ДД ЧЧ:ММ, например 2026-11-05 19:30.");
  const [, y, mo, d, h, mi] = match.map((part) => part);
  const parts = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) };
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day || parts.hour > 23 || parts.minute > 59) throw new Error("Дата или время указаны некорректно.");
  const fmt = formatterFor(validateClubTimeZone(timeZone));
  const matches = [];
  for (let candidate = naive - 14 * 60 * 60_000; candidate <= naive + 14 * 60 * 60_000; candidate += 15 * 60_000) {
    const mapped = Object.fromEntries(fmt.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    if (mapped.year === parts.year && mapped.month === parts.month && mapped.day === parts.day && mapped.hour === parts.hour && mapped.minute === parts.minute) matches.push(candidate);
  }
  if (matches.length === 0) throw new Error("Такого местного времени нет из-за перехода на летнее или зимнее время. Выберите другое время.");
  if (matches.length > 1) throw new Error("Это местное время повторяется при переводе часов. Выберите однозначное время.");
  return new Date(matches[0]).toISOString();
}

function validateZoomUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "").trim()); } catch { throw new Error("Укажите корректную ссылку Zoom."); }
  const host = url.hostname.toLowerCase();
  const allowed = host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoom.com" || host.endsWith(".zoom.com");
  if (url.protocol !== "https:" || !allowed || url.username || url.password || (url.port && url.port !== "443") || url.toString().length > 2048) throw new Error("Допускаются только короткие HTTPS-ссылки с доменов zoom.us или zoom.com.");
  return url.toString();
}

function parseMeetingInstant(value, timeZone) {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return toUtcFromClubLocal(raw, timeZone);
}

function validateMeetingInput(input, { timeZone, now = new Date() } = {}) {
  const timezone = validateClubTimeZone(timeZone);
  const title = String(input.title ?? "").trim();
  if (title.length < 1 || title.length > 200) throw new Error("Название должно содержать от 1 до 200 символов.");
  const startsAt = parseMeetingInstant(input.startsAt, timezone);
  const scheduledAt = parseMeetingInstant(input.scheduledAt, timezone);
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(current) || Date.parse(scheduledAt) <= current) throw new Error("Время отправки должно быть в будущем.");
  if (Date.parse(startsAt) <= Date.parse(scheduledAt)) throw new Error("Приглашение нужно отправить до начала встречи.");
  const zoomUrl = validateZoomUrl(input.zoomUrl);
  const note = String(input.note ?? "").trim();
  if (note.length > 500) throw new Error("Дополнительный текст должен быть не длиннее 500 символов.");
  return { title, startsAt, scheduledAt, zoomUrl, note: note || null, timezone };
}

function classifyTelegramError(error) {
  const code = Number(error?.error_code ?? error?.statusCode ?? error?.status);
  const parameters = error?.parameters ?? error?.payload?.parameters ?? {};
  if (code === 429) return { kind: "temporary", code: "TELEGRAM_RATE_LIMIT", delayMs: Math.max(1, Number(parameters.retry_after) || 1) * 1000 };
  const description = String(error?.description ?? error?.response?.description ?? error?.message ?? "").toLowerCase();
  if (code === 403) return { kind: "unavailable", code: "CHAT_UNAVAILABLE" };
  if (code === 400 && /chat not found|user is deactivated|bot was blocked|bot can't initiate|bot cannot initiate|peer_id_invalid|user not found/.test(description)) {
    return { kind: "unavailable", code: "CHAT_UNAVAILABLE" };
  }
  // Other 4xx responses may be a request/configuration problem, while 5xx,
  // network failures, and timeouts do not establish whether Telegram accepted
  // the message. All require review because an automatic retry can duplicate it.
  return { kind: "uncertain", code: "DELIVERY_RESULT_REQUIRES_REVIEW" };
}

function createMeetingBroadcastScheduler({ store, adapters, getAdminRole, demoMode = false, demoAdminIds = [], workerId, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = 5_000, leaseMs = 10 * 60_000, minSendIntervalMs = 50, setIntervalFn = setInterval, clearIntervalFn = clearInterval, logger = console }) {
  const worker = String(workerId || `meeting-worker-${process.pid}-${Math.random().toString(36).slice(2)}`);
  let timer = null;
  let running = false;
  let stopped = false;
  const nowIso = () => (now() instanceof Date ? now() : new Date(now())).toISOString();
  const context = { demoMode, demoAdminIds };
  const platformAdapters = adapters || {};
  const requireTelegramAdapter = () => {
    if (typeof platformAdapters.telegram?.sendMessage !== "function") {
      throw new Error("Для рассылки не настроен Telegram-адаптер sendMessage.");
    }
    return platformAdapters.telegram;
  };

  async function tick() {
    if (stopped || running) return { skipped: true };
    const telegramAdapter = requireTelegramAdapter();
    running = true;
    const outcomes = [];
    try {
      while (!stopped) {
        const current = nowIso();
        const broadcast = store.claimNext(current, worker, leaseMs);
        if (!broadcast) break;
        if (broadcast.review) { outcomes.push({ status: "uncertain", code: "DELIVERY_RESULT_REQUIRES_REVIEW" }); continue; }
        if (broadcast.stale) { outcomes.push({ status: "stale" }); continue; }
        if (!getAdminRole(broadcast.created_by)) {
          store.fail(broadcast.id, worker, "ADMIN_ACCESS_REVOKED", nowIso());
          outcomes.push({ status: "failed", code: "ADMIN_ACCESS_REVOKED" });
          continue;
        }
        store.ensureRecipients(broadcast.id, context);
        let haltedForRetry = false;
        for (const deliveryId of store.nextDeliveries(broadcast.id, nowIso())) {
          if (stopped) break;
          if (!getAdminRole(broadcast.created_by)) {
            store.fail(broadcast.id, worker, "ADMIN_ACCESS_REVOKED", nowIso());
            haltedForRetry = true;
            break;
          }
          store.heartbeat(broadcast.id, worker, nowIso(), leaseMs);
          const candidate = store.getDelivery(deliveryId);
          if (!candidate) continue;
          if (typeof platformAdapters[candidate.platform]?.sendMessage !== "function") {
            store.markUnavailable(candidate.id, "DELIVERY_ADAPTER_UNAVAILABLE");
            outcomes.push({ status: "unavailable", code: "DELIVERY_ADAPTER_UNAVAILABLE" });
            continue;
          }
          const when = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: broadcast.timezone }).format(new Date(broadcast.starts_at));
          const body = [`📅 Приглашение на встречу клуба «Магия утра»`, `\n${String(broadcast.title).slice(0, 200)}`, `\n${when} (${broadcast.timezone})`, `\n${broadcast.zoom_url}`, broadcast.note ? `\n\n${String(broadcast.note).slice(0, 500)}` : ""].join("");
          // Eligibility and exclusive sender ownership are claimed together in
          // a short IMMEDIATE transaction. Ownership remains held across the
          // actual API call and its durable outcome, without holding SQLite's
          // write transaction open during the network request.
          let reservation;
          while (!stopped) {
            if (!getAdminRole(broadcast.created_by)) {
              store.fail(broadcast.id, worker, "ADMIN_ACCESS_REVOKED", nowIso());
              haltedForRetry = true;
              break;
            }
            store.heartbeat(broadcast.id, worker, nowIso(), leaseMs);
            reservation = store.reserveDeliverySend(deliveryId, nowIso(), leaseMs, broadcast.id, worker, context);
            if (reservation.status !== "wait") break;
            const waitMs = Math.max(1, Date.parse(reservation.waitUntil) - Date.parse(nowIso()));
            // Short slices let shutdown interrupt long retry_after delays.
            await sleep(Math.min(waitMs, 1000));
          }
          if (stopped || haltedForRetry) break;
          if (reservation.status === "meeting_started") {
            outcomes.push({ status: "stopped_for_review", code: "MEETING_STARTED_REQUIRES_REVIEW" });
            haltedForRetry = true;
            break;
          }
          if (reservation.status === "unavailable") {
            outcomes.push({ status: "unavailable", code: "RECIPIENT_NOT_ELIGIBLE" });
            continue;
          }
          if (reservation.status !== "reserved") {
            const current = store.get(broadcast.id);
            if (current?.status !== "sending" || current.lease_owner !== worker) { haltedForRetry = true; break; }
            continue;
          }
          const delivery = reservation.delivery;
          const complete = (outcome, code = null, delayMs = 0) => store.completeDeliverySend({
            deliveryId: delivery.id, ownerToken: reservation.ownerToken, outcome, code,
            now: nowIso(), delayMs, minSendIntervalMs, broadcastId: broadcast.id, worker
          });
          // Revalidate immediately before crossing the external API boundary.
          // SQLite and Telegram cannot share a transaction, so a withdrawal
          // after this check but before Telegram accepts the request remains
          // an unavoidable, very small race window.
          const finalEligibility = store.recheckReservedDelivery(delivery.id, reservation.ownerToken, context);
          if (finalEligibility.status === "unavailable") {
            outcomes.push({ status: "unavailable", code: "RECIPIENT_NOT_ELIGIBLE" });
            continue;
          }
          if (finalEligibility.status !== "eligible") {
            throw new Error("Повторная проверка получателя не подтвердила отправку.");
          }
          try {
            await platformAdapters[delivery.platform].sendMessage(delivery.messenger_user_id, body);
          } catch (error) {
            const classified = classifyTelegramError(error);
            if (classified.kind === "unavailable") {
              complete("unavailable", classified.code);
              outcomes.push({ status: "unavailable", code: classified.code });
              continue;
            }
            if (classified.kind === "temporary") {
              complete("temporary", classified.code, classified.delayMs);
              outcomes.push({ status: "retry", code: classified.code, delayMs: classified.delayMs });
              haltedForRetry = true;
              break;
            }
            complete("uncertain", classified.code);
            outcomes.push({ status: "uncertain", code: classified.code });
            haltedForRetry = true;
            break;
          }
          // A SQLite failure here deliberately leaves exclusive ownership in
          // place. Recovery requires confirmed process death and marks the
          // delivery uncertain; it must never blindly repeat an accepted send.
          complete("sent");
          outcomes.push({ status: "sent" });
        }
        if (!haltedForRetry) store.finish(broadcast.id, worker, nowIso());
        else if (store.get(broadcast.id)?.status === "sending") store.finish(broadcast.id, worker, nowIso());
      }
      return outcomes;
    } finally { running = false; }
  }

  function start() {
    if (stopped) throw new Error("Планировщик рассылок уже остановлен.");
    requireTelegramAdapter();
    if (timer) return stop;
    const reportFailure = (error) => {
      const allowedName = new Set(["Error", "TypeError", "RangeError", "SqliteError"]);
      const detail = { event: "meeting_scheduler_error", error_type: allowedName.has(error?.name) ? error.name : "Error" };
      if (/^[A-Z0-9_]{1,48}$/.test(String(error?.code ?? ""))) detail.error_code = error.code;
      logger.error?.(JSON.stringify(detail));
    };
    timer = setIntervalFn(() => { void tick().catch(reportFailure); }, intervalMs);
    timer.unref?.();
    void tick().catch(reportFailure);
    return stop;
  }
  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    while (running) await sleep(10);
  }
  return { start, stop, tick, get running() { return running; } };
}

module.exports = { validateClubTimeZone, toUtcFromClubLocal, validateZoomUrl, validateMeetingInput, parseMeetingInstant, classifyTelegramError, createMeetingBroadcastScheduler };

