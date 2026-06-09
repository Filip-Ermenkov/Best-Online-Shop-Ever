import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated symmetric encryption for the TOTP shared secret at rest.
 *
 * A TOTP secret is NOT like a password: the server must recover the plaintext
 * on every verification to recompute codes, so it cannot be one-way hashed. It
 * must instead be ENCRYPTED with a key the database alone never holds. We use
 * AES-256-GCM (authenticated encryption — confidentiality + integrity) with the
 * application key supplied out-of-band via SSM Parameter Store / env, exactly
 * what `users.mfa_secret_encrypted` was schema-commented for:
 *
 *   "encrypted with the application key (never plaintext at rest). Even if the
 *    DB is dumped, the secret cannot generate codes without the app key."
 *
 * This matches the 2026 guidance (OWASP, Authgear) that TOTP seeds live in an
 * HSM/Vault or "at least AES-GCM" with the key managed separately from the DB.
 *
 * Wire format (all Base64, colon-delimited, versioned for future key rotation):
 *
 *   v1:<iv b64>:<authTag b64>:<ciphertext b64>
 *
 *   - v1            scheme tag — lets us migrate to a rotated key or a new
 *                   algorithm without ambiguity.
 *   - iv            12-byte random nonce (GCM standard; never reused per key).
 *   - authTag       16-byte GCM authentication tag — tamper-evidence.
 *   - ciphertext    AES-256-GCM(secret).
 */

const SCHEME = "v1";
const IV_BYTES = 12; // 96-bit nonce — the GCM-recommended size.
const KEY_BYTES = 32; // AES-256.

/**
 * Resolve and validate the 32-byte encryption key from its Base64 form (an env
 * var / SSM SecureString). Fails loudly: a misconfigured key must surface at
 * the first MFA operation, not corrupt a secret silently.
 */
export function loadMfaKey(base64Key: string | undefined | null): Buffer {
  if (!base64Key) {
    throw new Error("MFA encryption key is not configured");
  }
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, "base64");
  } catch {
    throw new Error("MFA encryption key is not valid Base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MFA encryption key must be ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/** Generate a fresh Base64 256-bit key — used by the key-provisioning helper
 *  (scripts) and tests. Operators store the output in SSM, never in the repo. */
export function generateMfaKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Encrypt a plaintext secret with AES-256-GCM. Returns the wire string. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    SCHEME,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a wire string produced by encryptSecret. Throws if the key is wrong,
 * the payload was tampered with (GCM tag mismatch), or the format is unknown —
 * the caller treats any throw as "MFA secret unusable" and fails the auth
 * attempt closed.
 */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== SCHEME) {
    throw new Error("Unrecognised MFA secret format");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const authTag = Buffer.from(parts[2]!, "base64");
  const ciphertext = Buffer.from(parts[3]!, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Constant-time equality for two Base64 keys — used by the key-rotation check
 * so a timing side-channel can't probe the configured key. Exposed for tests.
 */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
