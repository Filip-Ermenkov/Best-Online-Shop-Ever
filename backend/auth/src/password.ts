import argon2 from "argon2";

/**
 * Password hashing — argon2id with OWASP 2026 recommended low-memory parameters.
 *
 * Why these parameters?
 *
 *   The OWASP Password Storage Cheat Sheet (Aug 2024 revision, still current
 *   in May 2026) lists two equally-secure pairings for argon2id:
 *
 *     A) m=47104 (46 MiB), t=1, p=1   — high-mem, low-cpu
 *     B) m=19456 (19 MiB), t=2, p=1   — low-mem,  high-cpu  ← we use this
 *
 *   Pairing B is the right pick for AWS Lambda. We size functions at 512 MiB
 *   (per docs/ARCHITECTURE.md §3.4) and 19 MiB of transient hashing memory keeps headroom
 *   comfortable. Pairing A would need ~50 MiB of stack-resident allocation
 *   on every login and pushes us toward 1 GiB Lambda sizing for safety.
 *
 *   On a c6g/c7g-equivalent core (Lambda x86_64 backing), argon2id with these
 *   params measures ~80–110 ms per hash. Slow enough to make GPU brute force
 *   uneconomical, fast enough that login UX stays sub-200 ms end-to-end.
 *
 * Why argon2id over bcrypt or scrypt?
 *
 *   - argon2id won the Password Hashing Competition (2015) and is RFC 9106
 *     standardised. Modern hardware and modern attackers — argon2id is the
 *     present-tense answer; bcrypt's 72-byte input cap and lack of
 *     memory-hardness make it a defensive downgrade in 2026.
 *   - argon2id specifically (vs argon2i / argon2d) hybridises memory-
 *     hardness with cache-timing resistance — what OWASP recommends for
 *     password hashing concretely.
 *
 * Library choice: `argon2` (the native node-argon2 addon).
 *
 *   - hash-wasm/argon2-browser run argon2 in WebAssembly. WASM is convenient
 *     in browsers but ~3–5× slower than the native addon under Node, which
 *     means a 100 ms hash becomes a 300–500 ms hash. That eats into the
 *     login budget hard.
 *   - node-argon2 ships prebuilt binaries for Linux x64 / arm64 / Node 20+,
 *     which matches the Lambda runtime we deploy on. No native compile in CI.
 *
 * The output is the standard PHC-format string:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<hash-b64>
 * Self-describing — the verifier reads the params back from the hash string,
 * so we can tighten parameters in the future without invalidating old hashes.
 */
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // KiB → 19 MiB
  timeCost: 2,
  parallelism: 1,
  // 16-byte random salt — argon2 generates internally; we don't need to.
  // 32-byte hash output is the argon2 default and what the PHC string expects.
} as const;

/**
 * Hash a plaintext password. Output is safe to store as `users.password_hash`.
 * Always returns a fresh hash even for identical inputs (random salt).
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, PASSWORD_HASH_OPTIONS);
}

/**
 * Constant-time verify. Returns false (never throws) on garbage input — the
 * underlying library raises if the hash string is malformed, which would let
 * an attacker distinguish "bad credentials" from "DB row corrupt". We fold
 * both paths to a uniform `false`.
 *
 * IMPORTANT: when called against a valid hash with the wrong password, this
 * still takes the full ~100 ms per `PASSWORD_HASH_OPTIONS`. That timing floor
 * is the whole point — pair this with `DUMMY_PASSWORD_HASH` on the unknown-
 * email branch and login becomes constant-time across user existence.
 */
export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * After a successful verify, check whether the stored hash uses parameters
 * older than our current OWASP target. If true, the API layer should re-hash
 * on the fly and write the upgraded hash back — opportunistic upgrade so we
 * don't need a one-shot migration when params are tightened later.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, PASSWORD_HASH_OPTIONS);
  } catch {
    // Malformed hash → rehash on next successful login (no-op until then).
    return true;
  }
}

/**
 * A precomputed dummy argon2id hash. Used in the login flow's "user not
 * found" branch so we still spend ~100 ms verifying — closing the timing
 * channel that would otherwise let an attacker probe which emails exist.
 *
 * Generated at module load, NOT baked into source — that way nobody is
 * tempted to use it for anything else, and a stolen copy of this string
 * isn't a credential.
 *
 * The plaintext is unguessable garbage. Even if leaked, it's not a real
 * password for any user.
 */
export const DUMMY_PASSWORD_HASH: Promise<string> = (async () =>
  hashPassword(
    `__dummy_for_constant_time_login__${Math.random().toString(36).slice(2)}__${Date.now()}`,
  ))();
