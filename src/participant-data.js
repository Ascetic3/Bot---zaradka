const crypto = require("node:crypto");
const database = require("./database");
const { ExpiringMap } = require("./expiring-map");
const path = require("node:path");
const { classifyDatabasePath } = require("./database/config");

const CONFIRMATION_TTL_MS = 10 * 60_000;

function createParticipantDataService({
  db = database,
  now = () => new Date(),
  createToken = () => crypto.randomBytes(24).toString("base64url"),
  confirmations = new ExpiringMap(CONFIRMATION_TTL_MS),
  isDemoMode = () => String(process.env.DEMO_MODE).toLowerCase() === "true",
  projectRoot = path.resolve(__dirname, "..")
} = {}) {
  const actorKey = (id) => {
    const value = String(id ?? "");
    if (!/^\d+$/.test(value)) throw new Error("Действие требует Telegram ID текущего пользователя.");
    return value;
  };
  const requireAdmin = (telegramId) => {
    const role = db.getAdminRole(actorKey(telegramId));
    if (!new Set(["owner", "admin"]).has(role)) throw new Error("Недостаточно административных прав.");
    return role;
  };
  const assertDataChangesEnabled = (actorId, participantId = null) => {
    if (!isDemoMode()) return;
    try { classifyDatabasePath(db.dbPath, { demoMode: "true", projectRoot }); }
    catch { throw Object.assign(new Error("Действие остановлено: подключение к подтверждённой демобазе отсутствует."), { code: "DEMO_DATABASE_MISMATCH" }); }
    const marked = participantId != null ? db.isDemoTestParticipant(participantId) : db.isDemoTestParticipantForTelegram(actorId);
    if (!marked) throw Object.assign(new Error("Действия с демоданными разрешены только для специально помеченных тестовых анкет."), { code: "DEMO_MODE_DATA_CHANGE_DISABLED" });
  };
  const issue = (operation, actorId, participantId, details = {}) => {
    const token = createToken();
    if (typeof token !== "string" || token.length < 20) throw new Error("Не удалось создать безопасное подтверждение.");
    confirmations.set(token, { operation, actorId: actorKey(actorId), participantId: Number(participantId), ...details });
    return token;
  };

  function prepareOwnDeletion(telegramId) {
    const actorId = actorKey(telegramId);
    assertDataChangesEnabled(actorId);
    const participant = db.findParticipantByTelegramIdIncludingWithdrawn(actorId);
    if (!participant) return { status: "not_found" };
    const impact = db.getParticipantDeletionPreview(participant.id);
    return { status: "confirmation_required", confirmation_token: issue("delete_own", actorId, participant.id), impact };
  }

  function confirmOwnDeletion(telegramId, token) {
    const actorId = actorKey(telegramId);
    assertDataChangesEnabled(actorId);
    const pending = typeof token === "string" ? confirmations.get(token) : null;
    if (!pending || pending.operation !== "delete_own" || pending.actorId !== actorId) return { status: "invalid_or_expired_confirmation" };
    const participant = db.findParticipantByTelegramIdIncludingWithdrawn(actorId);
    confirmations.delete(token);
    if (!participant || Number(participant.id) !== pending.participantId) return { status: "not_found" };
    const result = isDemoMode() ? db.deleteDemoTestParticipantById(pending.participantId, actorId, { projectRoot }) : db.deleteParticipantById(pending.participantId);
    return { status: result.deleted ? "deleted" : "not_found", impact: result };
  }

  // The self-service UI records a request for operator review. It deliberately
  // never calls deleteParticipantById; destructive execution remains separate.
  function prepareOwnDeletionRequest(telegramId) {
    const actorId = actorKey(telegramId);
    assertDataChangesEnabled(actorId);
    const requests = db.getParticipantDataRequestsForTelegram(actorId);
    if (!requests) return { status: "not_found" };
    if (requests.deletion_request_status === "pending_review") {
      return { status: "already_requested", request_id: requests.deletion_request_id, requested_at: requests.deletion_requested_at };
    }
    const participant = db.findParticipantByTelegramIdIncludingWithdrawn(actorId);
    if (!participant) return { status: "not_found" };
    return { status: "confirmation_required", confirmation_token: issue("delete_request", actorId, participant.id) };
  }

  function confirmOwnDeletionRequest(telegramId, token) {
    const actorId = actorKey(telegramId);
    assertDataChangesEnabled(actorId);
    const pending = typeof token === "string" ? confirmations.get(token) : null;
    if (!pending || pending.operation !== "delete_request" || pending.actorId !== actorId) return { status: "invalid_or_expired_confirmation" };
    const participant = db.findParticipantByTelegramIdIncludingWithdrawn(actorId);
    if (!participant || Number(participant.id) !== pending.participantId) {
      confirmations.delete(token);
      return { status: "not_found" };
    }
    confirmations.delete(token);
    return db.createParticipantDeletionRequestForTelegram(actorId, crypto.randomUUID(), now().toISOString());
  }

  function prepareAdminDeletion(adminTelegramId, participantId) {
    const actorId = actorKey(adminTelegramId);
    requireAdmin(actorId);
    assertDataChangesEnabled(actorId, participantId);
    const impact = db.getParticipantDeletionPreview(participantId);
    if (!impact) return { status: "not_found" };
    return { status: "confirmation_required", confirmation_token: issue("delete_admin", actorId, impact.participant_id), impact };
  }

  function confirmAdminDeletion(adminTelegramId, token) {
    const actorId = actorKey(adminTelegramId);
    const pending = typeof token === "string" ? confirmations.get(token) : null;
    if (!pending || pending.operation !== "delete_admin" || pending.actorId !== actorId) return { status: "invalid_or_expired_confirmation" };
    try { requireAdmin(actorId); }
    catch { confirmations.delete(token); throw new Error("Административные права отозваны."); }
    confirmations.delete(token);
    assertDataChangesEnabled(actorId, pending.participantId);
    const result = isDemoMode() ? db.deleteDemoTestParticipantById(pending.participantId, actorId, { projectRoot }) : db.deleteParticipantById(pending.participantId);
    return { status: result.deleted ? "deleted" : "not_found", impact: result };
  }

  function cancelConfirmation(telegramId, token) {
    const actorId = actorKey(telegramId);
    const pending = typeof token === "string" ? confirmations.get(token) : null;
    if (!pending || pending.actorId !== actorId) return false;
    return confirmations.delete(token);
  }

  function getConfirmationStatus(telegramId, token) {
    const actorId = actorKey(telegramId);
    const pending = typeof token === "string" ? confirmations.get(token) : null;
    if (!pending) return "expired";
    return pending.actorId === actorId ? "owned" : "other_user";
  }

  function prepareOwnConsentWithdrawal(telegramId) {
    const actorId = actorKey(telegramId);
    assertDataChangesEnabled(actorId);
    const participant = db.findParticipantByTelegramIdIncludingWithdrawn(actorId);
    if (!participant) return { status: "not_found" };
    const state = db.getParticipantConsentState(participant.id);
    if (!state?.active) return { status: state?.consent_withdrawn_at ? "already_requested" : "no_active_consent" };
    return {
      status: "confirmation_required",
      confirmation_token: issue("withdraw_consent", actorId, participant.id, { consentAt: state.consent_at })
    };
  }

  function confirmOwnConsentWithdrawal(telegramId, token) {
    const actorId = actorKey(telegramId);
    assertDataChangesEnabled(actorId);
    const pending = typeof token === "string" ? confirmations.get(token) : null;
    if (!pending || pending.operation !== "withdraw_consent" || pending.actorId !== actorId) return { status: "invalid_or_expired_confirmation" };
    const participant = db.findParticipantByTelegramIdIncludingWithdrawn(actorId);
    if (!participant || Number(participant.id) !== pending.participantId) {
      confirmations.delete(token);
      return { status: "not_found" };
    }
    confirmations.delete(token);
    const result = db.recordConsentWithdrawalRequest(pending.participantId, now().toISOString(), pending.consentAt);
    if (result.status === "received") return { ...result, processing_based_on_consent_allowed: false };
    return result;
  }

  function resolveConsentWithdrawal(adminTelegramId, requestId, resolution) {
    requireAdmin(adminTelegramId);
    return db.resolveConsentWithdrawalRequest(requestId, resolution, now().toISOString());
  }

  return {
    prepareOwnDeletion,
    confirmOwnDeletion,
    prepareOwnDeletionRequest,
    confirmOwnDeletionRequest,
    prepareAdminDeletion,
    confirmAdminDeletion,
    cancelConfirmation,
    getConfirmationStatus,
    prepareOwnConsentWithdrawal,
    confirmOwnConsentWithdrawal,
    resolveConsentWithdrawal,
    getConsentState: (participantId) => db.getParticipantConsentState(participantId),
    stop() { confirmations.stop(); }
  };
}

module.exports = { createParticipantDataService, CONFIRMATION_TTL_MS };

