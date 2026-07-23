/**
 * Envelope encryption with per-tenant data keys.
 *
 * SOC 2 CC6.7, GDPR Art. 32, HIPAA §164.312(a)(2)(iv). docs/14 §2.
 *
 * Why envelope rather than a single application key:
 *
 *  - **Crypto-shredding.** GDPR Art. 17 erasure across backups is otherwise
 *    impossible — you cannot surgically delete a row from an immutable backup.
 *    Destroy the tenant's DEK and every ciphertext for that tenant, in every
 *    backup, becomes permanently unreadable. This is the only defensible answer
 *    to "how do you erase from backups?" in a security review.
 *  - **Blast radius.** One compromised DEK exposes one tenant.
 *  - **Rotation.** DEKs rotate without re-encrypting under a new master key.
 *
 * The KMS interface is deliberately thin so AWS KMS / GCP KMS / Vault Transit drop
 * in without touching callers. In production the master key NEVER leaves the KMS.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Encrypted payload. Self-describing so the format can evolve. */
export interface Envelope {
  /** Format version — lets us change algorithms without breaking old ciphertext. */
  v: 1;
  /** Which tenant DEK encrypted this. */
  keyId: string;
  /** Base64 IV. */
  iv: string;
  /** Base64 ciphertext. */
  ct: string;
  /** Base64 GCM auth tag. */
  tag: string;
}

/** Wraps/unwraps data keys. Backed by a real KMS in production. */
export interface KeyManagementService {
  /** Encrypt a DEK under the master key. */
  wrap(plaintextKey: Buffer, context: Record<string, string>): Promise<string>;
  /** Decrypt a wrapped DEK. */
  unwrap(wrappedKey: string, context: Record<string, string>): Promise<Buffer>;
  generateDataKey(): Promise<Buffer>;
}

export interface TenantKeyRecord {
  keyId: string;
  orgId: string;
  wrappedKey: string;
  createdAt: string;
  /** Set when the key is destroyed — crypto-shredding for erasure. */
  destroyedAt?: string;
  rotatedFrom?: string;
}

export interface TenantKeyStore {
  getActive(orgId: string): Promise<TenantKeyRecord | null>;
  getById(keyId: string): Promise<TenantKeyRecord | null>;
  put(record: TenantKeyRecord): Promise<void>;
  markDestroyed(keyId: string): Promise<void>;
}

export class KeyDestroyedError extends Error {
  constructor(keyId: string) {
    super(
      `data key ${keyId} has been destroyed — this ciphertext is permanently unrecoverable ` +
        `(crypto-shredded, likely by a GDPR Art. 17 erasure request)`,
    );
    this.name = 'KeyDestroyedError';
  }
}

export class EncryptionService {
  /** Unwrapped DEK cache. Bounded lifetime so a memory dump has a short window. */
  private readonly cache = new Map<string, { key: Buffer; expiresAt: number }>();
  private readonly cacheTtlMs = 5 * 60_000;

  constructor(
    private readonly kms: KeyManagementService,
    private readonly keys: TenantKeyStore,
  ) {}

  /** Encrypt for a tenant, creating their DEK on first use. */
  async encrypt(orgId: string, plaintext: string | Buffer): Promise<Envelope> {
    const record = (await this.keys.getActive(orgId)) ?? (await this.createKey(orgId));
    if (record.destroyedAt) throw new KeyDestroyedError(record.keyId);

    const key = await this.dek(record);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ct = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ]);

    return {
      v: 1,
      keyId: record.keyId,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  async decrypt(envelope: Envelope): Promise<Buffer> {
    const record = await this.keys.getById(envelope.keyId);
    if (!record) throw new Error(`unknown key: ${envelope.keyId}`);
    if (record.destroyedAt) throw new KeyDestroyedError(envelope.keyId);

    const key = await this.dek(record);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    // GCM verifies integrity on final() — tampering throws here.
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  }

  async decryptToString(envelope: Envelope): Promise<string> {
    return (await this.decrypt(envelope)).toString('utf8');
  }

  /**
   * CRYPTO-SHREDDING. Destroys a tenant's data key, rendering every ciphertext
   * encrypted under it permanently unreadable — including in backups and archives
   * we cannot selectively edit.
   *
   * This is irreversible and must be gated on an explicit, audited confirmation.
   * docs/14 §3 item 6.
   */
  async destroyTenantKey(orgId: string): Promise<{ keyId: string }> {
    const record = await this.keys.getActive(orgId);
    if (!record) throw new Error(`no active key for org ${orgId}`);
    await this.keys.markDestroyed(record.keyId);
    this.cache.delete(record.keyId);
    return { keyId: record.keyId };
  }

  /** Rotate the DEK. Old ciphertext stays readable under the previous key. */
  async rotate(orgId: string): Promise<TenantKeyRecord> {
    const previous = await this.keys.getActive(orgId);
    const next = await this.createKey(orgId, previous?.keyId);
    return next;
  }

  private async createKey(orgId: string, rotatedFrom?: string): Promise<TenantKeyRecord> {
    const plaintextKey = await this.kms.generateDataKey();
    // The org id is bound as encryption context, so a wrapped key stolen from one
    // tenant cannot be unwrapped in another's context.
    const wrappedKey = await this.kms.wrap(plaintextKey, { orgId });
    const record: TenantKeyRecord = {
      keyId: `dek_${randomBytes(8).toString('hex')}`,
      orgId,
      wrappedKey,
      createdAt: new Date().toISOString(),
      rotatedFrom,
    };
    await this.keys.put(record);
    this.cache.set(record.keyId, {
      key: plaintextKey,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return record;
  }

  private async dek(record: TenantKeyRecord): Promise<Buffer> {
    const cached = this.cache.get(record.keyId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;

    const key = await this.kms.unwrap(record.wrappedKey, { orgId: record.orgId });
    this.cache.set(record.keyId, { key, expiresAt: Date.now() + this.cacheTtlMs });
    return key;
  }
}

// ---------------------------------------------------------------------------

/**
 * Development KMS. The master key lives in memory, which is exactly what a real
 * KMS exists to prevent — this must never run in production.
 */
export class LocalKms implements KeyManagementService {
  private readonly masterKey: Buffer;

  constructor(masterKeyHex?: string) {
    if (process.env.NODE_ENV === 'production' && !masterKeyHex) {
      throw new Error(
        'LocalKms must not be used in production — configure AWS KMS, GCP KMS, or Vault Transit',
      );
    }
    this.masterKey = masterKeyHex
      ? Buffer.from(masterKeyHex, 'hex')
      : randomBytes(KEY_BYTES);
  }

  async generateDataKey(): Promise<Buffer> {
    return randomBytes(KEY_BYTES);
  }

  async wrap(plaintextKey: Buffer, context: Record<string, string>): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  async unwrap(wrappedKey: string, context: Record<string, string>): Promise<Buffer> {
    const raw = Buffer.from(wrappedKey, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

export class MemoryTenantKeyStore implements TenantKeyStore {
  private readonly byId = new Map<string, TenantKeyRecord>();

  async getActive(orgId: string) {
    return (
      [...this.byId.values()]
        .filter((k) => k.orgId === orgId && !k.destroyedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
  }
  async getById(keyId: string) {
    return this.byId.get(keyId) ?? null;
  }
  async put(record: TenantKeyRecord) {
    this.byId.set(record.keyId, record);
  }
  async markDestroyed(keyId: string) {
    const record = this.byId.get(keyId);
    if (record) this.byId.set(keyId, { ...record, destroyedAt: new Date().toISOString() });
  }
}

/** Constant-time secret comparison. Use for tokens, API keys, webhook signatures. */
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
