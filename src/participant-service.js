const crypto = require("node:crypto");
const db = require("./database");
const {
  verifyPhoneVerificationProof,
  verifyConsentAttestation
} = require("./registration-attestations");

const allowedContacts = new Set(["Telegram", "MAX", "Телефонный звонок", "Электронная почта"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fieldLimits = Object.freeze({ first_name: 100, last_name: 100, city: 100, email: 254, referral_source: 120 });

function validateFieldValue(field, value, current = {}) {
  if (field === "first_name" || field === "last_name") {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) throw new Error(`${field === "first_name" ? "Имя" : "Фамилия"} обязательно.`);
    if (normalized.length > fieldLimits[field]) throw new Error(`${field === "first_name" ? "Имя" : "Фамилия"} должно быть не длиннее ${fieldLimits[field]} символов.`);
    return normalized;
  }
  if (["city", "email", "referral_source"].includes(field)) {
    if ((value == null || (typeof value === "string" && !value.trim())) && field === "email" && current.preferred_contact === "Электронная почта") {
      throw new Error("Нельзя очистить email, пока выбран способ связи «Электронная почта». Сначала измените предпочтительный способ связи.");
    }
    if (value == null || (typeof value === "string" && !value.trim())) return null;
    if (typeof value !== "string") throw new Error("Введите текстовое значение.");
    const normalized = value.trim();
    if (normalized.length > fieldLimits[field]) {
      const labels = { city: "Город", email: "Email", referral_source: "Источник знакомства" };
      throw new Error(`${labels[field]} должен быть не длиннее ${fieldLimits[field]} символов.`);
    }
    if (field === "email" && !emailPattern.test(normalized)) throw new Error("Введите корректный email.");
    return normalized;
  }
  if (field === "preferred_contact") {
    if (value == null || value === "") return null;
    if (!allowedContacts.has(value)) throw new Error("Выберите корректный способ связи.");
    if (value === "Электронная почта" && !emailPattern.test(String(current.email ?? ""))) {
      throw new Error("Сначала добавьте корректный email, затем выберите его способом связи.");
    }
    return value;
  }
  throw new Error("Это поле нельзя изменить.");
}

function validateParticipantFields(answers, { requirePreferredContact = true } = {}) {
  const fields = {
    first_name: validateFieldValue("first_name", answers.first_name, answers),
    last_name: validateFieldValue("last_name", answers.last_name, answers),
    city: validateFieldValue("city", answers.city, answers),
    email: validateFieldValue("email", answers.email, answers),
    referral_source: validateFieldValue("referral_source", answers.referral_source, answers),
    preferred_contact: validateFieldValue("preferred_contact", answers.preferred_contact, {
      ...answers,
      email: answers.email == null || answers.email === "" ? null : validateFieldValue("email", answers.email, answers)
    })
  };
  if (requirePreferredContact && !fields.preferred_contact) throw new Error("Способ связи не выбран или некорректен.");
  return fields;
}

function validateParticipantUpdate(participant, field, value) {
  if (!participant) throw new Error("Анкета не найдена.");
  const normalized = validateFieldValue(field, value, participant);
  const candidate = { ...participant, [field]: normalized };
  if (candidate.preferred_contact === "Электронная почта" && !emailPattern.test(String(candidate.email ?? ""))) {
    throw new Error("Для связи по электронной почте необходимо сохранить корректный email.");
  }
  return normalized;
}

function getRegistrationPolicy(env = process.env) {
  const url = String(env.PRIVACY_POLICY_URL ?? "").trim();
  const version = String(env.PRIVACY_POLICY_VERSION ?? "").trim();
  let validUrl = false;
  try { validUrl = ["https:", "http:"].includes(new URL(url).protocol); } catch {}
  return validUrl && version ? { url, version } : null;
}

function validateRegistration(answers, policy = getRegistrationPolicy(), account = null, options = {}) {
  if (!policy) throw new Error("Регистрация требует настроенных PRIVACY_POLICY_URL и PRIVACY_POLICY_VERSION.");
  if (!answers || typeof answers !== "object") throw new Error("Анкета отсутствует.");
  const database = options.database || db;
  const env = options.env || process.env;
  const now = options.now ?? Date.now();
  let phone;
  try { phone = database.normalizePhone(answers.phone); } catch { throw new Error("Номер телефона не прошёл проверку."); }
  const accountId = String(account?.messenger_user_id ?? "");
  const attestedPhone = verifyPhoneVerificationProof(answers.phone_verification, {
    platform: account?.platform,
    accountId,
    phone
  }, { env, now, allowedMethods: options.allowedPhoneMethods });
  if (!isValidTimestamp(answers.phone_confirmed_at) || !attestedPhone ||
      answers.phone_verification.confirmed_at !== answers.phone_confirmed_at ||
      String(answers.phone_confirmed_by ?? "") !== accountId) {
    const error = new Error("Телефон не подтверждён этим аккаунтом доверенным способом, либо подтверждение устарело.");
    error.code = "PHONE_PROOF_INVALID";
    throw error;
  }
  if (answers.personal_data_consent !== true) throw new Error("Нет согласия на обработку персональных данных.");
  if (!isValidTimestamp(answers.consent_at)) throw new Error("Не сохранены дата и время согласия.");
  if (String(answers.consent_given_by ?? "") !== accountId) throw new Error("Согласие не подтверждено этим аккаунтом.");
  if (answers.policy_url !== policy.url || answers.policy_version !== policy.version || answers.consent_version !== policy.version) throw new Error("Согласие относится к другой версии политики. Начните регистрацию заново.");
  const consentMatches = verifyConsentAttestation(answers.consent_attestation, {
    platform: account?.platform,
    accountId,
    policyUrl: policy.url,
    policyVersion: policy.version
  }, { env, now });
  if (!consentMatches || answers.consent_attestation.accepted_at !== answers.consent_at) {
    const error = new Error("Нет доверенного подтверждения согласия с текущей версией политики.");
    error.code = "CONSENT_ATTESTATION_INVALID";
    throw error;
  }
  const fields = validateParticipantFields(answers);
  return { ...answers, ...fields, phone };
}

function isValidTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now();
}
function createRegistrationService({ database = db, envProvider = () => process.env, now = () => Date.now(), allowedPhoneMethods = { telegram: ["telegram_contact"] } } = {}) {
  function currentPolicy(env = envProvider()) { return getRegistrationPolicy(env); }

  function validateSubmission(answers, account, env = envProvider()) {
    return validateRegistration(answers, currentPolicy(env), account, {
      database,
      env,
      now: now(),
      allowedPhoneMethods
    });
  }

  function registerParticipant(answers, account, env = envProvider()) {
    // Final guard sits beside persistence, not only at the Telegram handler.
    if (String(env.DEMO_MODE).toLowerCase() === "true") {
      const error = new Error("Настоящая регистрация отключена в демонстрационном режиме.");
      error.code = "DEMO_MODE_REGISTRATION_DISABLED";
      throw error;
    }
    const validated = validateSubmission(answers, account, env);
    return database.registerParticipant({ ...validated, personal_data_consent: true }, account);
  }

  function inspectVerifiedPhone(account, phoneVerification, env = envProvider()) {
    const phone = database.normalizePhone(phoneVerification?.phone);
    const valid = verifyPhoneVerificationProof(phoneVerification, {
      platform: account?.platform,
      accountId: account?.messenger_user_id,
      phone
    }, { env, now: now(), allowedMethods: allowedPhoneMethods });
    if (!valid) {
      const error = new Error("Для поиска анкеты требуется действительное свежее подтверждение телефона.");
      error.code = "PHONE_PROOF_INVALID";
      throw error;
    }
    const existing = database.findParticipantByPhone(phone);
    if (!existing) return { status: "new_participant" };
    if (existing.consent_withdrawn_at || existing.personal_data_consent !== 1 || !existing.consent_at || !existing.consent_version) return { status: "unavailable" };
    return { status: "account_confirmation_required" };
  }

  function assertLinkingEnabled(env) {
    if (String(env.DEMO_MODE).toLowerCase() === "true") {
      const error = new Error("Связывание реальных аккаунтов отключено в демонстрационном режиме.");
      error.code = "DEMO_MODE_LINK_DISABLED";
      throw error;
    }
  }

  function validateLinkPhoneProof(account, phoneVerification, env = envProvider()) {
    const phone = database.normalizePhone(phoneVerification?.phone);
    const validPhoneProof = verifyPhoneVerificationProof(phoneVerification, {
      platform: account?.platform,
      accountId: account?.messenger_user_id,
      phone
    }, { env, now: now(), allowedMethods: allowedPhoneMethods });
    if (!validPhoneProof) {
      const error = new Error("Для связывания нужен действительный и свежий результат подтверждения телефона.");
      error.code = "PHONE_PROOF_INVALID";
      throw error;
    }
    return { phone, verifiedAt: phoneVerification.confirmed_at, proofMethod: phoneVerification.method };
  }

  function createAccountLinkRequest({ participantId, account, phoneVerification }, env = envProvider()) {
    assertLinkingEnabled(env);
    const verified = validateLinkPhoneProof(account, phoneVerification, env);
    const participant = database.getParticipant(participantId);
    const consent = database.getParticipantConsentState(participantId);
    if (!participant || !consent?.active) {
      const error = new Error("Анкета недоступна для связывания.");
      error.code = "CONSENT_WITHDRAWN";
      throw error;
    }
    return database.createAccountLinkRequest({
      requestId: crypto.randomUUID(), participantId,
      targetPlatform: String(account.platform).toLowerCase(), targetAccountId: String(account.messenger_user_id),
      verifiedPhone: verified.phone, proofMethod: verified.proofMethod, verifiedAt: verified.verifiedAt,
      expiresAt: new Date(now() + 10 * 60 * 1000).toISOString(), now: new Date(now()).toISOString()
    });
  }

  function transitionLinkRequestFromTelegram(ctx, requestId, action, env = envProvider()) {
    assertLinkingEnabled(env);
    const telegramId = String(ctx?.from?.id ?? "");
    const callbackActorId = String(ctx?.callbackQuery?.from?.id ?? "");
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(requestId ?? ""));
    if (ctx?.chat?.type !== "private" || !/^\d+$/.test(telegramId) || callbackActorId !== telegramId || !validId || ctx?.callbackQuery?.data !== `link:${action}:${requestId}`) {
      const error = new Error("Решение по запросу должно прийти отдельным действием из личного чата Telegram.");
      error.code = "ACCOUNT_LINK_APPROVAL_INVALID";
      throw error;
    }
    return database.transitionAccountLinkRequest({ requestId, telegramActorId: telegramId, action, now: new Date(now()).toISOString() });
  }

  function approveAccountLinkRequestFromTelegram(ctx, requestId, env = envProvider()) { return transitionLinkRequestFromTelegram(ctx, requestId, "approve", env); }
  function rejectAccountLinkRequestFromTelegram(ctx, requestId, env = envProvider()) { return transitionLinkRequestFromTelegram(ctx, requestId, "reject", env); }
  function cancelAccountLinkRequestFromTelegram(ctx, requestId, env = envProvider()) { return transitionLinkRequestFromTelegram(ctx, requestId, "cancel", env); }

  function completeAccountLinkRequest({ requestId, account, phoneVerification }, env = envProvider()) {
    assertLinkingEnabled(env);
    const verified = validateLinkPhoneProof(account, phoneVerification, env);
    return database.completeAccountLinkRequest({
      requestId, platform: String(account.platform).toLowerCase(), messengerUserId: String(account.messenger_user_id),
      verifiedPhone: verified.phone, proofMethod: verified.proofMethod, verifiedAt: verified.verifiedAt,
      now: new Date(now()).toISOString()
    });
  }

  return { getRegistrationPolicy: currentPolicy, validateRegistration: validateSubmission, registerParticipant, inspectVerifiedPhone, createAccountLinkRequest, approveAccountLinkRequestFromTelegram, rejectAccountLinkRequestFromTelegram, cancelAccountLinkRequestFromTelegram, completeAccountLinkRequest };
}

const defaultRegistrationService = createRegistrationService();

function createRegisteredParticipant(answers, account, env = process.env) {
  return defaultRegistrationService.registerParticipant(answers, account, env).participant;
}

module.exports = {
  getRegistrationPolicy,
  validateFieldValue,
  validateParticipantFields,
  validateParticipantUpdate,
  validateRegistration,
  createRegisteredParticipant,
  createRegistrationService,
  registrationService: defaultRegistrationService,
  fieldLimits
};
