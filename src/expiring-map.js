class ExpiringMap extends Map {
  constructor(ttlMs, { now = Date.now, cleanupIntervalMs = Math.min(ttlMs, 60_000) } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.now = now;
    this.expirations = new Map();
    this.timer = cleanupIntervalMs > 0 ? setInterval(() => this.cleanup(), cleanupIntervalMs) : null;
    this.timer?.unref?.();
  }

  set(key, value) {
    this.expirations.set(key, this.now() + this.ttlMs);
    return super.set(key, value);
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const expiresAt = this.expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.expirations.set(key, this.now() + this.ttlMs);
    return super.get(key);
  }

  has(key) {
    if (!super.has(key)) return false;
    if ((this.expirations.get(key) ?? 0) <= this.now()) {
      this.delete(key);
      return false;
    }
    this.expirations.set(key, this.now() + this.ttlMs);
    return true;
  }

  delete(key) {
    this.expirations.delete(key);
    return super.delete(key);
  }

  clear() {
    this.expirations.clear();
    super.clear();
  }

  cleanup() {
    const timestamp = this.now();
    for (const [key, expiresAt] of this.expirations) if (expiresAt <= timestamp) this.delete(key);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }
}

module.exports = { ExpiringMap };
