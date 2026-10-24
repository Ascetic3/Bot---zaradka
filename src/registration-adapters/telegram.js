const { makePhoneVerificationProof, makeConsentAttestation } = require("../registration-attestations");

function createOwnContactProof({ contact, telegramUserId, normalizePhone, confirmedAt = new Date().toISOString(), env = process.env }) {
  const accountId = String(telegramUserId ?? "");
  if (!accountId || !contact || String(contact.user_id ?? "") !== accountId) {
    const error = new Error("Телефон должен быть передан как собственный контакт Telegram.");
    error.code = "TELEGRAM_CONTACT_NOT_OWNED";
    throw error;
  }
  return makePhoneVerificationProof({
    platform: "telegram",
    accountId,
    phone: normalizePhone(contact.phone_number),
    confirmedAt,
    method: "telegram_contact"
  }, env);
}

function createConsentReceipt({ telegramUserId, policyUrl, policyVersion, acceptedAt = new Date().toISOString(), env = process.env }) {
  return makeConsentAttestation({
    platform: "telegram",
    accountId: String(telegramUserId ?? ""),
    policyUrl,
    policyVersion,
    acceptedAt
  }, env);
}

module.exports = { createOwnContactProof, createConsentReceipt };
