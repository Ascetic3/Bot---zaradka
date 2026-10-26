const crypto = require('node:crypto');
const os = require('node:os');

const MAX_DELIVERY_ATTEMPTS = 5;
const MINIMUM_SEND_DELAY_MS = 60_000;
const TELEGRAM_PARTICIPANT_ELIGIBILITY = `p.phone_confirmed_at IS NOT NULL AND trim(p.phone_confirmed_at)<>''
  AND p.personal_data_consent=1 AND p.consent_at IS NOT NULL AND trim(p.consent_at)<>''
  AND p.consent_version IS NOT NULL AND trim(p.consent_version)<>'' AND p.consent_withdrawn_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM participant_deletion_requests dr WHERE dr.participant_id=p.id AND dr.status='pending_review')`;

function isDeliveryRecipientEligible(connection, row, { demoMode = false, demoAdminIds = [] } = {}) {
  if (row.platform !== 'telegram') return false;
  if (demoMode) {
    const allowlist = new Set(demoAdminIds.map(String));
    return allowlist.has(String(row.messenger_user_id)) && Boolean(connection.prepare(`SELECT 1 FROM admins a
      JOIN telegram_private_chats c ON c.telegram_id=a.telegram_id WHERE a.telegram_id=? AND a.role IN ('owner','admin')`)
      .get(String(row.messenger_user_id)));
  }
  if (row.participant_id == null) return false;
  return Boolean(connection.prepare(`SELECT 1 FROM participants p
    JOIN accounts a ON a.participant_id=p.id AND a.platform='telegram'
    JOIN telegram_private_chats c ON c.telegram_id=a.messenger_user_id
    LEFT JOIN demo_test_participants d ON d.participant_id=p.id
    WHERE p.id=? AND a.messenger_user_id=? AND d.participant_id IS NULL AND ${TELEGRAM_PARTICIPANT_ELIGIBILITY}`)
    .get(row.participant_id, String(row.messenger_user_id)));
}

function createMeetingBroadcastStore(connection) {
  const tx = (operation) => connection.transaction(operation).immediate();
  const get = (id) => connection.prepare(`SELECT b.*, m.title, m.starts_at, m.zoom_url, m.note
    FROM meeting_broadcasts b JOIN meetings m ON m.id=b.meeting_id WHERE b.id=?`).get(Number(id)) ?? null;
  return {
    createDraft({ title, startsAt, scheduledAt, zoomUrl, note, timezone, createdBy, now }) {
      return tx(() => {
        const meeting = connection.prepare(`INSERT INTO meetings(title,starts_at,zoom_url,note,created_by,created_at)
          VALUES(@title,@startsAt,@zoomUrl,@note,@createdBy,@now)`).run({ title, startsAt, zoomUrl, note: note || null, createdBy: String(createdBy), now });
        const broadcast = connection.prepare(`INSERT INTO meeting_broadcasts(meeting_id,status,scheduled_at,timezone,created_by,created_at,updated_at,next_attempt_at)
          VALUES(?,'draft',?,?,?,?,?,?)`).run(Number(meeting.lastInsertRowid), scheduledAt, timezone, String(createdBy), now, now, scheduledAt);
        return Number(broadcast.lastInsertRowid);
      });
    },
    get,
    updateDraft(id, actor, values, now) {
      return tx(() => {
        const current = get(id);
        if (!current || current.status !== 'draft') return false;
        connection.prepare(`UPDATE meetings SET title=?,starts_at=?,zoom_url=?,note=? WHERE id=?`).run(values.title, values.startsAt, values.zoomUrl, values.note || null, current.meeting_id);
        return connection.prepare(`UPDATE meeting_broadcasts SET scheduled_at=?,timezone=?,next_attempt_at=?,updated_at=?,created_by=?
          WHERE id=? AND status='draft'`).run(values.scheduledAt, values.timezone, values.scheduledAt, now, String(actor), Number(id)).changes === 1;
      });
    },
    confirmDraft(id, actor, now, { deferPast = false } = {}) {
      return tx(() => {
        const item = get(id);
        if (!item || item.status !== 'draft') return false;
        if (deferPast && Date.parse(item.scheduled_at) < Date.parse(now) + MINIMUM_SEND_DELAY_MS) {
          const minimum = Date.parse(now) + MINIMUM_SEND_DELAY_MS;
          if (minimum >= Date.parse(item.starts_at)) return 'meeting_too_soon';
          // Do not silently shift a draft here. The UI must ask whether to
          // start a fresh 60-second delay or return to the time editor.
          return 'too_soon';
        }
        return connection.prepare(`UPDATE meeting_broadcasts SET status='scheduled',updated_at=?,next_attempt_at=scheduled_at,created_by=?
          WHERE id=? AND status='draft'`).run(now, String(actor), Number(id)).changes === 1;
      });
    },
    cancel(id, actor, now) {
      return connection.prepare(`UPDATE meeting_broadcasts SET status='cancelled',updated_at=?,lease_owner=NULL,lease_until=NULL
        WHERE id=? AND status IN ('draft','scheduled')`).run(now, Number(id)).changes === 1;
    },
    updateScheduled(id, actor, values, now) {
      return tx(() => {
        const current = get(id);
        if (!current || current.status !== 'scheduled') return false;
        connection.prepare(`UPDATE meetings SET title=?,starts_at=?,zoom_url=?,note=? WHERE id=?`).run(values.title, values.startsAt, values.zoomUrl, values.note || null, current.meeting_id);
        const changed = connection.prepare(`UPDATE meeting_broadcasts SET scheduled_at=?,timezone=?,next_attempt_at=?,updated_at=?,created_by=?
          WHERE id=? AND status='scheduled'`).run(values.scheduledAt, values.timezone, values.scheduledAt, now, String(actor), Number(id));
        return changed.changes === 1;
      });
    },
    sendNow(id, actor, now, { draftOnly = false } = {}) {
      const scheduledAt = new Date(Date.parse(now) + MINIMUM_SEND_DELAY_MS).toISOString();
      const allowedStatus = draftOnly
        ? "status='draft'"
        : "(status IN ('draft','scheduled') OR (status='failed' AND last_error_code='STALE_INVITATION_REQUIRES_REVIEW'))";
      return connection.prepare(`UPDATE meeting_broadcasts SET status='scheduled',scheduled_at=?,next_attempt_at=?,updated_at=?,last_error_code=NULL,created_by=?
        WHERE id=? AND ${allowedStatus}
          AND EXISTS (SELECT 1 FROM meetings m WHERE m.id=meeting_id AND m.starts_at>?)`).run(scheduledAt, scheduledAt, now, String(actor), Number(id), scheduledAt).changes === 1;
    },
    list(actor, limit = 20) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
      return connection.prepare(`SELECT b.id,b.meeting_id,b.status,b.scheduled_at,b.timezone,b.last_error_code,
          m.title,m.starts_at,m.zoom_url,m.note
        FROM meeting_broadcasts b JOIN meetings m ON m.id=b.meeting_id
        ORDER BY b.created_at DESC,b.id DESC LIMIT ?`).all(safeLimit);
    },
    summary(id, actor) {
      const item = connection.prepare(`SELECT b.id,b.meeting_id,b.status,b.scheduled_at,b.timezone,b.last_error_code,
          m.title,m.starts_at,m.zoom_url,m.note
        FROM meeting_broadcasts b JOIN meetings m ON m.id=b.meeting_id WHERE b.id=?`).get(Number(id));
      if (!item) return null;
      const counts = connection.prepare(`SELECT status,COUNT(*) AS count FROM meeting_deliveries WHERE broadcast_id=? GROUP BY status`).all(Number(id));
      return { ...item, deliveries: Object.fromEntries(counts.map((row) => [row.status, row.count])) };
    },
    previewRecipients({ demoMode = false, demoAdminIds = [] } = {}) {
      if (demoMode) {
        const ids = [...new Set(demoAdminIds.map(String).filter((value) => /^\d{1,20}$/.test(value)))];
        if (!ids.length) return { total: 0, eligible: 0, excluded: 0, reasons: [] };
        const placeholders = ids.map(() => '?').join(',');
        const eligible = Number(connection.prepare(`SELECT COUNT(DISTINCT a.telegram_id) AS count FROM admins a
          JOIN telegram_private_chats c ON c.telegram_id=a.telegram_id
          WHERE a.role IN ('owner','admin') AND a.telegram_id IN (${placeholders})`).get(...ids).count);
        return { total: ids.length, eligible, excluded: ids.length - eligible,
          reasons: ids.length === eligible ? [] : [{ reason: "Нет действующей административной роли или личный чат не открыт", count: ids.length - eligible }] };
      }
      const rows = connection.prepare(`WITH assessed AS (
        SELECT CASE
          WHEN p.personal_data_consent<>1 OR p.consent_at IS NULL OR trim(p.consent_at)='' OR p.consent_version IS NULL OR trim(p.consent_version)='' OR p.consent_withdrawn_at IS NOT NULL THEN 'Нет действующего согласия на обработку'
          WHEN p.phone_confirmed_at IS NULL OR trim(p.phone_confirmed_at)='' THEN 'Телефон не подтверждён'
          WHEN EXISTS (SELECT 1 FROM demo_test_participants d WHERE d.participant_id=p.id) THEN 'Тестовая анкета исключена'
          WHEN EXISTS (SELECT 1 FROM participant_deletion_requests dr WHERE dr.participant_id=p.id AND dr.status='pending_review') THEN 'Запрос удаления ожидает рассмотрения'
          WHEN NOT EXISTS (SELECT 1 FROM accounts a WHERE a.participant_id=p.id AND a.platform='telegram') THEN 'Нет связанного Telegram-аккаунта'
          WHEN NOT EXISTS (SELECT 1 FROM accounts a JOIN telegram_private_chats c ON c.telegram_id=a.messenger_user_id WHERE a.participant_id=p.id AND a.platform='telegram') THEN 'Личный чат с ботом не открыт'
          ELSE NULL END AS reason
        FROM participants p
      ) SELECT reason,COUNT(*) AS count FROM assessed GROUP BY reason`).all();
      const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
      const eligible = Number(rows.find((row) => row.reason === null)?.count || 0);
      const reasons = rows.filter((row) => row.reason !== null).map((row) => ({ reason: row.reason, count: Number(row.count) }));
      return { total, eligible, excluded: total - eligible, reasons };
    },
    countEligibleRecipients(context = {}) { return this.previewRecipients(context).eligible; },    claimNext(now, worker, leaseMs) {
      return tx(() => {
        // A process may stop while an already-authorized Telegram request is
        // in flight. Once its delivery lease expires, its outcome is unknown;
        // retain that fact without ever resuming the cancelled broadcast.
        connection.prepare(`UPDATE meeting_deliveries SET status='uncertain',next_attempt_at=NULL,lease_until=NULL,
          last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW'
           WHERE status='sending' AND (lease_until IS NULL OR lease_until<=?)
             AND id NOT IN (SELECT sender_delivery_id FROM meeting_send_rate_limit_state WHERE sender_token IS NOT NULL)
            AND broadcast_id IN (SELECT id FROM meeting_broadcasts WHERE status='cancelled' AND last_error_code='ADMIN_STOPPED')`).run(now);
        const due = connection.prepare(`SELECT b.*,m.title,m.starts_at,m.zoom_url,m.note FROM meeting_broadcasts b
          JOIN meetings m ON m.id=b.meeting_id
          WHERE (b.status='scheduled' AND b.scheduled_at<=? AND (b.next_attempt_at IS NULL OR b.next_attempt_at<=?))
              OR (b.status='sending' AND COALESCE(b.next_attempt_at,b.scheduled_at)<=? AND (b.lease_until IS NULL OR b.lease_until<=?)
                AND NOT EXISTS (SELECT 1 FROM meeting_deliveries d JOIN meeting_send_rate_limit_state rate
                  ON rate.sender_delivery_id=d.id AND rate.sender_token IS NOT NULL WHERE d.broadcast_id=b.id))
          ORDER BY b.scheduled_at,b.id LIMIT 1`).get(now, now, now, now);
        if (!due) return null;
        if (Date.parse(now) - Date.parse(due.scheduled_at) > 24 * 60 * 60 * 1000 || Date.parse(due.starts_at) <= Date.parse(now)) {
          connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code='STALE_INVITATION_REQUIRES_REVIEW',updated_at=?,lease_owner=NULL,lease_until=NULL,next_attempt_at=NULL
            WHERE id=? AND status IN ('scheduled','sending')`).run(now, due.id);
          return { stale: true, broadcast: due };
        }
        const existingUncertain = connection.prepare(`SELECT 1 FROM meeting_deliveries WHERE broadcast_id=? AND status='uncertain' LIMIT 1`).get(due.id);
        if (existingUncertain) {
          connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW',next_attempt_at=NULL,
            lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('scheduled','sending')`).run(now, due.id);
          return { review: true, broadcast: due };
        }
        if (due.status === 'sending') {
          const uncertain = connection.prepare(`UPDATE meeting_deliveries SET status='uncertain',next_attempt_at=NULL,lease_until=NULL,last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW'
            WHERE broadcast_id=? AND status='sending' AND (lease_until IS NULL OR lease_until<=?)`).run(due.id, now);
          if (uncertain.changes > 0) {
            connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW',next_attempt_at=NULL,
              lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending'`).run(now, due.id);
            return { review: true, broadcast: due };
          }
        }
        const changed = connection.prepare(`UPDATE meeting_broadcasts SET status='sending',lease_owner=?,lease_until=?,attempt_count=attempt_count+1,updated_at=?
          WHERE id=? AND ((status='scheduled' AND scheduled_at<=?) OR (status='sending' AND (lease_until IS NULL OR lease_until<=?)))`).run(String(worker), new Date(Date.parse(now) + leaseMs).toISOString(), now, due.id, now, now);
        return changed.changes === 1 ? get(due.id) : null;
      });
    },
    heartbeat(id, worker, now, leaseMs) {
      return connection.prepare(`UPDATE meeting_broadcasts SET lease_until=?,updated_at=? WHERE id=? AND status='sending' AND lease_owner=?`)
        .run(new Date(Date.parse(now) + leaseMs).toISOString(), now, Number(id), String(worker)).changes === 1;
    },
    requestStop(id, now) {
      return tx(() => {
        const before = connection.prepare(`SELECT status,last_error_code,lease_owner,lease_until FROM meeting_broadcasts WHERE id=?`).get(Number(id));
        if (!before) return 'not_active';
        const changed = connection.prepare(`UPDATE meeting_broadcasts
          SET status='cancelled',last_error_code='ADMIN_STOPPED',next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE id=? AND status='sending' AND lease_owner IS ? AND lease_until IS ?`)
          .run(now, Number(id), before.lease_owner, before.lease_until);
        if (changed.changes === 1) return 'stopped';
        const current = connection.prepare(`SELECT status,last_error_code FROM meeting_broadcasts WHERE id=?`).get(Number(id));
        return current?.status === 'cancelled' && current.last_error_code === 'ADMIN_STOPPED' ? 'already_stopped' : 'not_active';
      });
    },
    ensureRecipients(id, { demoMode = false, demoAdminIds = [] } = {}) {
      return tx(() => {
        const broadcast = get(id);
        if (!broadcast || broadcast.status !== 'sending') return 0;
        if (demoMode) {
          const insert = connection.prepare(`INSERT OR IGNORE INTO meeting_deliveries(broadcast_id,participant_id,platform,messenger_user_id,status)
            SELECT ?,NULL,'telegram',a.telegram_id,'pending' FROM admins a JOIN telegram_private_chats c ON c.telegram_id=a.telegram_id
            WHERE a.telegram_id=? AND a.role IN ('owner','admin')`);
          let count = 0;
          for (const userId of new Set(demoAdminIds.map(String).filter((value) => /^\d{1,20}$/.test(value)))) count += insert.run(Number(id), userId).changes;
          return count;
        }
        // Telegram is the only live delivery channel. A future MAX adapter must
        // choose one active, linked and deliverable account per participant;
        // preferred_contact is for personal contact and must not select a platform.
        return connection.prepare(`INSERT OR IGNORE INTO meeting_deliveries(broadcast_id,participant_id,platform,messenger_user_id,status)
          SELECT DISTINCT ?,p.id,'telegram',a.messenger_user_id,'pending'
          FROM participants p JOIN accounts a ON a.participant_id=p.id AND a.platform='telegram'
          JOIN telegram_private_chats c ON c.telegram_id=a.messenger_user_id
          LEFT JOIN demo_test_participants d ON d.participant_id=p.id
          WHERE d.participant_id IS NULL AND ${TELEGRAM_PARTICIPANT_ELIGIBILITY}`).run(Number(id)).changes;
      });
    },
    nextDeliveries(id, now) {
      return connection.prepare(`SELECT id FROM meeting_deliveries WHERE broadcast_id=? AND attempt_count<?
        AND (status='pending' OR (status='temporary_error' AND (next_attempt_at IS NULL OR next_attempt_at<=?)))
        ORDER BY id LIMIT 500`).all(Number(id), MAX_DELIVERY_ATTEMPTS, now).map((row) => row.id);
    },
    getDelivery(id) {
      return connection.prepare('SELECT * FROM meeting_deliveries WHERE id=?').get(Number(id)) ?? null;
    },
    reserveDeliverySend(id, now, leaseMs, broadcastId, worker, { demoMode = false, demoAdminIds = [] } = {}) {
      return tx(() => {
        const row = connection.prepare(`SELECT d.*,b.status AS broadcast_status,b.lease_owner AS broadcast_lease_owner,
            b.lease_until AS broadcast_lease_until,b.scheduled_at,b.next_attempt_at,m.starts_at
          FROM meeting_deliveries d JOIN meeting_broadcasts b ON b.id=d.broadcast_id
          JOIN meetings m ON m.id=b.meeting_id WHERE d.id=? AND b.id=?`).get(Number(id), Number(broadcastId));
        if (!row || row.broadcast_status !== 'sending' || row.broadcast_lease_owner !== String(worker)
            || !row.broadcast_lease_until || row.broadcast_lease_until <= now || row.scheduled_at > now
            || (row.next_attempt_at && row.next_attempt_at > now)) return { status: 'not_reserved' };
        if (row.starts_at <= now) {
          connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code='MEETING_STARTED_REQUIRES_REVIEW',
            next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_owner=?`)
            .run(now, Number(broadcastId), String(worker));
          return { status: 'meeting_started' };
        }
        if (row.attempt_count >= MAX_DELIVERY_ATTEMPTS
            || !['pending','temporary_error'].includes(row.status)
            || (row.status === 'temporary_error' && row.next_attempt_at && row.next_attempt_at > now)) return { status: 'not_reserved' };

        const eligible = isDeliveryRecipientEligible(connection, row, { demoMode, demoAdminIds });
        if (!eligible) {
          connection.prepare(`UPDATE meeting_deliveries SET status='unavailable',next_attempt_at=NULL,lease_until=NULL,
            last_error_code='RECIPIENT_NOT_ELIGIBLE' WHERE id=? AND status IN ('pending','temporary_error')`).run(Number(id));
          return { status: 'unavailable', delivery_id: Number(id) };
        }
        const limit = connection.prepare(`SELECT next_allowed_at,blocked_until,sender_token FROM meeting_send_rate_limit_state WHERE singleton_id=1`).get();
        if (!limit) throw new Error("Состояние общего ограничения скорости отправки отсутствует.");
        for (const value of [limit.next_allowed_at, limit.blocked_until]) {
          if (value !== null && !Number.isFinite(Date.parse(value))) throw new Error("Состояние общего ограничения скорости отправки содержит некорректное время.");
        }
        // Never steal an active sender on a timer: a suspended process may wake
        // after the timer and still call Telegram. Recovery requires proof that
        // the owning OS process has exited.
        if (limit.sender_token) return { status: 'wait', waitUntil: new Date(Date.parse(now) + 1000).toISOString(), ownerBusy: true };
        const availableAt = Math.max(Date.parse(limit.next_allowed_at || now), Date.parse(limit.blocked_until || now));
        if (availableAt > Date.parse(now)) return { status: 'wait', waitUntil: new Date(availableAt).toISOString() };
        const ownerToken = crypto.randomBytes(32).toString('hex');
        const changed = connection.prepare(`UPDATE meeting_deliveries SET status='sending',attempt_count=attempt_count+1,lease_until=?
          WHERE id=? AND attempt_count<? AND (status='pending' OR (status='temporary_error' AND (next_attempt_at IS NULL OR next_attempt_at<=?)))`)
          .run(new Date(Date.parse(now) + leaseMs).toISOString(), Number(id), MAX_DELIVERY_ATTEMPTS, now);
        if (changed.changes !== 1) return { status: 'not_reserved' };
        const owned = connection.prepare(`UPDATE meeting_send_rate_limit_state
          SET sender_token=?,sender_pid=?,sender_host=?,sender_delivery_id=?,sender_acquired_at=?
          WHERE singleton_id=1 AND sender_token IS NULL`)
          .run(ownerToken, process.pid, os.hostname(), Number(id), now);
        if (owned.changes !== 1) throw new Error('Не удалось закрепить исключительное право отправки.');
        return { status: 'reserved', ownerToken, delivery: connection.prepare('SELECT * FROM meeting_deliveries WHERE id=?').get(Number(id)) };
      });
    },
    recheckReservedDelivery(id, ownerToken, { demoMode = false, demoAdminIds = [] } = {}) {
      return tx(() => {
        const owner = connection.prepare(`SELECT sender_token,sender_delivery_id FROM meeting_send_rate_limit_state WHERE singleton_id=1`).get();
        if (!owner || owner.sender_token !== ownerToken || owner.sender_delivery_id !== Number(id)) {
          throw new Error('Право отправки изменилось; Telegram API не вызывается.');
        }
        const row = connection.prepare(`SELECT d.* FROM meeting_deliveries d WHERE d.id=? AND d.status='sending'`).get(Number(id));
        if (!row) throw new Error('Зарезервированная доставка изменилась; Telegram API не вызывается.');
        if (isDeliveryRecipientEligible(connection, row, { demoMode, demoAdminIds })) return { status: 'eligible' };

        const changed = connection.prepare(`UPDATE meeting_deliveries SET status='unavailable',next_attempt_at=NULL,
          lease_until=NULL,last_error_code='RECIPIENT_NOT_ELIGIBLE' WHERE id=? AND status='sending'`).run(Number(id));
        if (changed.changes !== 1) throw new Error('Результат повторной проверки получателя изменился.');
        const released = connection.prepare(`UPDATE meeting_send_rate_limit_state SET sender_token=NULL,sender_pid=NULL,
          sender_host=NULL,sender_delivery_id=NULL,sender_acquired_at=NULL
          WHERE singleton_id=1 AND sender_token=? AND sender_delivery_id=?`).run(ownerToken, Number(id));
        if (released.changes !== 1) throw new Error('Право отправки не освобождено после отказа получателю.');
        return { status: 'unavailable' };
      });
    },
    completeDeliverySend({ deliveryId, ownerToken, outcome, code = null, now, delayMs = 0, minSendIntervalMs = 50, broadcastId, worker }) {
      return tx(() => {
        const owner = connection.prepare(`SELECT sender_token,sender_delivery_id,blocked_until FROM meeting_send_rate_limit_state WHERE singleton_id=1`).get();
        if (!owner || owner.sender_token !== ownerToken || owner.sender_delivery_id !== Number(deliveryId)) {
          throw new Error('Право отправки изменилось; результат требует ручной проверки.');
        }
        if (!Number.isFinite(Date.parse(now))) throw new Error('Время завершения отправки некорректно.');
        const errorCode = code == null ? null : String(code).slice(0, 64);
        let changed;
        let blockedUntil = owner.blocked_until;
        if (outcome === 'sent') {
          changed = connection.prepare(`UPDATE meeting_deliveries SET status='sent',sent_at=?,next_attempt_at=NULL,lease_until=NULL,last_error_code=NULL
            WHERE id=? AND status='sending'`).run(now, Number(deliveryId));
        } else if (outcome === 'unavailable') {
          changed = connection.prepare(`UPDATE meeting_deliveries SET status='unavailable',next_attempt_at=NULL,lease_until=NULL,last_error_code=?
            WHERE id=? AND status='sending'`).run(errorCode, Number(deliveryId));
        } else if (outcome === 'temporary') {
          const candidate = new Date(Date.parse(now) + Math.max(0, Number(delayMs) || 0)).toISOString();
          if (!blockedUntil || blockedUntil < candidate) blockedUntil = candidate;
          changed = connection.prepare(`UPDATE meeting_deliveries SET status='temporary_error',next_attempt_at=?,lease_until=NULL,last_error_code=?
            WHERE id=? AND status='sending'`).run(candidate, errorCode, Number(deliveryId));
        } else if (outcome === 'uncertain') {
          changed = connection.prepare(`UPDATE meeting_deliveries SET status='uncertain',next_attempt_at=NULL,lease_until=NULL,last_error_code=?
            WHERE id=? AND status='sending'`).run(errorCode || 'DELIVERY_RESULT_REQUIRES_REVIEW', Number(deliveryId));
          connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW',
            next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?
            WHERE id=? AND status='sending' AND lease_owner=?`).run(now, Number(broadcastId), String(worker));
        } else throw new Error('Неизвестный результат отправки.');
        if (changed.changes !== 1) throw new Error('Результат доставки изменился; требуется ручная проверка.');
        const nextAllowedAt = new Date(Date.parse(now) + Math.max(0, Number(minSendIntervalMs) || 0)).toISOString();
        const released = connection.prepare(`UPDATE meeting_send_rate_limit_state SET next_allowed_at=?,blocked_until=?,
          sender_token=NULL,sender_pid=NULL,sender_host=NULL,sender_delivery_id=NULL,sender_acquired_at=NULL
          WHERE singleton_id=1 AND sender_token=? AND sender_delivery_id=?`)
          .run(nextAllowedAt, blockedUntil, ownerToken, Number(deliveryId));
        if (released.changes !== 1) throw new Error('Право отправки не освобождено; требуется ручная проверка.');
        return true;
      });
    },
    getSenderState() {
      return connection.prepare(`SELECT sender_token,sender_pid,sender_host,sender_delivery_id,sender_acquired_at,
        next_allowed_at,blocked_until FROM meeting_send_rate_limit_state WHERE singleton_id=1`).get() ?? null;
    },
    recoverAbandonedSender(expectedToken, now) {
      return tx(() => {
        const owner = this.getSenderState();
        if (!owner?.sender_token || owner.sender_token !== expectedToken) throw new Error('Владелец отправки изменился; восстановление остановлено.');
        if (owner.sender_host !== os.hostname() || !Number.isSafeInteger(owner.sender_pid) || owner.sender_pid <= 0) {
          throw new Error('Гибель владельца отправки на этом компьютере не подтверждена.');
        }
        try { process.kill(owner.sender_pid, 0); }
        catch (error) {
          if (error?.code !== 'ESRCH') throw new Error('Гибель процесса отправки не подтверждена.');
          const delivery = connection.prepare('SELECT broadcast_id,status FROM meeting_deliveries WHERE id=?').get(owner.sender_delivery_id);
          if (delivery?.status === 'sending') connection.prepare(`UPDATE meeting_deliveries SET status='uncertain',next_attempt_at=NULL,
            lease_until=NULL,last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW' WHERE id=? AND status='sending'`).run(owner.sender_delivery_id);
          if (delivery) connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code='DELIVERY_RESULT_REQUIRES_REVIEW',
            next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending'`)
            .run(now, delivery.broadcast_id);
          const nextAllowedAt = new Date(Math.max(Date.parse(owner.next_allowed_at || now), Date.parse(now) + 50)).toISOString();
          connection.prepare(`UPDATE meeting_send_rate_limit_state SET next_allowed_at=?,sender_token=NULL,sender_pid=NULL,
            sender_host=NULL,sender_delivery_id=NULL,sender_acquired_at=NULL WHERE singleton_id=1 AND sender_token=?`)
            .run(nextAllowedAt, expectedToken);
          return { recovered: true, deliveryStatus: delivery?.status === 'sending' ? 'uncertain' : delivery?.status ?? null };
        }
        throw new Error('Процесс владельца ещё работает; право отправки не освобождено.');
      });
    },
    meetingStarted(id, now) {
      return Boolean(connection.prepare(`SELECT 1 FROM meeting_broadcasts b JOIN meetings m ON m.id=b.meeting_id
        WHERE b.id=? AND m.starts_at<=?`).get(Number(id), now));
    },
    markUnavailable(id, code) {
      return connection.prepare(`UPDATE meeting_deliveries SET status='unavailable',next_attempt_at=NULL,lease_until=NULL,last_error_code=?
        WHERE id=? AND status IN ('pending','temporary_error')`).run(String(code).slice(0, 64), Number(id)).changes === 1;
    },
    fail(id, worker, code, now) {
      return connection.prepare(`UPDATE meeting_broadcasts SET status='failed',last_error_code=?,next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=?
        WHERE id=? AND status='sending' AND lease_owner=?`).run(String(code).slice(0, 64), now, Number(id), String(worker)).changes === 1;
    },
    finish(id, worker, now) {
      return tx(() => {
        const counts = connection.prepare(`SELECT status,COUNT(*) AS count,MIN(next_attempt_at) AS next_at,MAX(attempt_count) AS attempts
          FROM meeting_deliveries WHERE broadcast_id=? GROUP BY status`).all(Number(id));
        const byStatus = Object.fromEntries(counts.map((row) => [row.status, row]));
        const pending = Number(byStatus.pending?.count ?? 0);
        const sending = Number(byStatus.sending?.count ?? 0);
        const uncertain = Number(byStatus.uncertain?.count ?? 0);
        const temporary = byStatus.temporary_error;
        let status, nextAttempt, errorCode = null;
        if (sending > 0) return { status: 'sending', busy: true };
        if (uncertain > 0) { status = 'failed'; errorCode = 'DELIVERY_RESULT_REQUIRES_REVIEW'; }
        else if (pending > 0) { status = 'sending'; nextAttempt = temporary?.next_at || now; }
        else if (status === 'failed') { /* preserve the manual-review outcome */ }
        else if (temporary && Number(temporary.attempts) < MAX_DELIVERY_ATTEMPTS) { status = 'sending'; nextAttempt = temporary.next_at || now; }
        else if (temporary) { status = 'failed'; errorCode = 'DELIVERY_RETRIES_EXHAUSTED'; }
        else if (counts.length === 0) { status = 'failed'; errorCode = 'NO_ELIGIBLE_RECIPIENTS'; }
        else { status = 'completed'; }
        connection.prepare(`UPDATE meeting_broadcasts SET status=?,next_attempt_at=?,last_error_code=?,lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE id=? AND status='sending' AND lease_owner=?`).run(status, nextAttempt ?? null, errorCode, now, Number(id), String(worker));
        return { status, nextAttempt: nextAttempt ?? null, errorCode };
      });
    }
  };
}

module.exports = { createMeetingBroadcastStore, MAX_DELIVERY_ATTEMPTS, MINIMUM_SEND_DELAY_MS };

