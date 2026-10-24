const crypto = require("node:crypto");

const ATTESTATION_VERSION = 1;
const PHONE_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

class AttestationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AttestationError";
    this.code = code;
  }
}

function signingKey(env = process.env) {
  const configured = String(env.PHONE_PROOF_SECRET ?? "").trim();
  const fallback = String(env.BOT_TOKEN ?? "").trim();
  const secret = configured || fallback;
  if (secret.length < 16) {
    throw new AttestationError("Не настроен ключ проверки регистрационных подтверждений.", "ATTESTATION_KEY_MISSING");
  }
  return crypto.createHash("sha256").update("magic-morning-registration-attestation:v1\0").update(secret).digest();
}

function sign(kind, claims, env) {
  return crypto.createHmac("sha256", signingKey(env)).update(JSON.stringify([kind, ATTESTATION_VERSION, claims])).digest("base64url");
}

function safeSignatureEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual, "base64url");
  const b = Buffer.from(expected, "base64url");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeIdentity(platform, accountId) {
  const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
  const normalizedId = String(accountId ?? "").trim();
  if (!["telegram", "max"].includes(normalizedPlatform) || !normalizedId) {
    throw new AttestationError("Платформа и идентификатор аккаунта обязательны.", "ATTESTATION_INVALID_IDENTITY");
  }
  return { platform: normalizedPlatform, account_id: normalizedId };
}

function normalizedTimestamp(value, code) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now()) {
    throw new AttestationError("Время подтверждения некорректно.", code);
  }
  return timestamp.toISOString();
}

function makePhoneVerificationProof({ platform, accountId, phone, confirmedAt, method }, env = process.env) {
  const identity = normalizeIdentity(platform, accountId);
  const normalizedPhone = String(phone ?? "").trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
    throw new AttestationError("Номер телефона должен быть нормализован до международного формата.", "PHONE_PROOF_INVALID");
  }
  const proof = {
    version: ATTESTATION_VERSION,
    ...identity,
    phone: normalizedPhone,
    confirmed_at: normalizedTimestamp(confirmedAt, "PHONE_PROOF_INVALID"),
    method: String(method ?? "").trim()
  };
  if (!proof.method) throw new AttestationError("Не указан доверенный способ проверки телефона.", "PHONE_PROOF_INVALID");
  proof.signature = sign("phone", proof, env);
  return proof;
}

function verifyPhoneVerificationProof(proof, expected, { env = process.env, now = Date.now(), allowedMethods = { telegram: ["telegram_contact"] } } = {}) {
  if (!proof || typeof proof !== "object" || proof.version !== ATTESTATION_VERSION) return false;
  const platform = String(proof.platform ?? "").toLowerCase();
  if (!Array.isArray(allowedMethods[platform]) || !allowedMethods[platform].includes(proof.method)) return false;
  let expectedIdentity;
  try { expectedIdentity = normalizeIdentity(expected?.platform, expected?.accountId); } catch { return false; }
  if (proof.platform !== expectedIdentity.platform || proof.account_id !== expectedIdentity.account_id || proof.phone !== expected.phone) return false;
  const timestamp = Date.parse(proof.confirmed_at);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > PHONE_PROOF_MAX_AGE_MS) return false;
  const claims = { ...proof };
  delete claims.signature;
  try { return safeSignatureEqual(proof.signature, sign("phone", claims, env)); } catch { return false; }
}

function makeConsentAttestation({ platform, accountId, policyUrl, policyVersion, acceptedAt }, env = process.env) {
  const identity = normalizeIdentity(platform, accountId);
  const url = String(policyUrl ?? "").trim();
  const version = String(policyVersion ?? "").trim();
  if (!url || !version) throw new AttestationError("Политика и её версия обязательны.", "CONSENT_ATTESTATION_INVALID");
  const receipt = {
    version: ATTESTATION_VERSION,
    ...identity,
    policy_url: url,
    policy_version: version,
    accepted_at: normalizedTimestamp(acceptedAt, "CONSENT_ATTESTATION_INVALID")
  };
  receipt.signature = sign("consent", receipt, env);
  return receipt;
}

function verifyConsentAttestation(receipt, expected, { env = process.env, now = Date.now() } = {}) {
  if (!receipt || typeof receipt !== "object" || receipt.version !== ATTESTATION_VERSION) return false;
  let identity;
  try { identity = normalizeIdentity(expected?.platform, expected?.accountId); } catch { return false; }
  if (receipt.platform !== identity.platform || receipt.account_id !== identity.account_id ||
      receipt.policy_url !== expected.policyUrl || receipt.policy_version !== expected.policyVersion) return false;
  const timestamp = Date.parse(receipt.accepted_at);
  if (!Number.isFinite(timestamp) || timestamp > now) return false;
  const claims = { ...receipt };
  delete claims.signature;
  try { return safeSignatureEqual(receipt.signature, sign("consent", claims, env)); } catch { return false; }
}

module.exports = {
  AttestationError,
  PHONE_PROOF_MAX_AGE_MS,
  makePhoneVerificationProof,
  verifyPhoneVerificationProof,
  makeConsentAttestation,
  verifyConsentAttestation
};
