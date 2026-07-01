import { z } from "zod";

/**
 * Store-settings registry — the single source of truth for every operator-
 * editable configuration value (docs/README.md §"Настройки на магазина").
 *
 * WHY A DB-BACKED REGISTRY AND NOT MORE ENV VARS
 * ----------------------------------------------
 * These values are *runtime application data*, not deploy-time configuration.
 * The shop's phone number, address, opening hours, and default pickup window are
 * things the single administrator changes from the admin panel on a Tuesday
 * afternoon — they MUST NOT require a redeploy. The Twelve-Factor "config in the
 * environment" rule is explicitly scoped to "everything that varies between
 * deploys" plus secrets; operator-editable business settings vary at *runtime*,
 * so env vars are the wrong home (changing an env var means rebuilding/
 * redeploying the Lambda). Secrets (DATABASE_URL, the KMS/MFA keys, queue URLs)
 * correctly stay in env / SSM — this registry holds only NON-secret business
 * config. See docs/ARCHITECTURE.md §13 (the "settings live in the DB" decision).
 *
 * STORED-XSS POSTURE
 * ------------------
 * Every value here is operator-entered free text that is later rendered in the
 * storefront and in emails. Following OWASP's "validate input, encode output"
 * layering: this module validates + normalises on write (trims, strips control
 * characters via a code-point scan, caps length, format-checks phone/email) and
 * the render side encodes on output (React auto-escapes text; the storefront's
 * strict nonce CSP blocks any inline execution; emails HTML-escape). No value is
 * ever treated as HTML, so there is nothing to "sanitise" — plain text in, plain
 * text out. Unknown keys are rejected outright (a strict allow-list).
 *
 * This module is PURE (no DB, no I/O) so it unit-tests in isolation; the routes
 * (routes/settings.ts public, routes/admin/settings.ts admin) and the seed are
 * its only consumers.
 */

// ─── Primitive field builders ────────────────────────────────────────────────

/**
 * Remove C0 (0x00–0x1F), DEL (0x7F) and C1 (0x80–0x9F) control characters.
 * A code-point scan rather than a regex character class on purpose: a literal
 * control-character class in a regex is fragile to editor/tool normalisation
 * (the same lesson lib/banner.ts records). These are all single-line fields, so
 * newlines and tabs are stripped too.
 */
export function stripControlChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const isC0 = cp <= 0x1f;
    const isDel = cp === 0x7f;
    const isC1 = cp >= 0x80 && cp <= 0x9f;
    if (isC0 || isDel || isC1) continue;
    out += ch;
  }
  return out;
}

/** Trimmed, control-char-stripped free text with a hard length cap. Empty OK. */
function freeText(max: number) {
  return z
    .string()
    .transform((s) => stripControlChars(s).trim())
    .pipe(z.string().max(max, `Стойността не може да е по-дълга от ${max} знака.`));
}

/**
 * A phone number (or empty). Permissive on format — a shop landline like
 * "+359 2 900 1234" must pass, so this is NOT the strict customer-phone E.164
 * normaliser. Digits, spaces, and the usual separators only; control chars
 * stripped first.
 */
function phoneField(max: number) {
  return z
    .string()
    .transform((s) => stripControlChars(s).trim())
    .pipe(
      z
        .string()
        .max(max, `Телефонът не може да е по-дълъг от ${max} знака.`)
        .regex(/^$|^[+0-9 ()\-]+$/, "Невалиден телефонен номер."),
    );
}

/** An email address (or empty — empty means "fall back to the derived default"). */
function emailField(max: number) {
  return z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .max(max, `Имейлът не може да е по-дълъг от ${max} знака.`)
        .refine(
          (s) => s === "" || z.string().email().safeParse(s).success,
          "Невалиден имейл адрес.",
        ),
    );
}

// ─── The registry ─────────────────────────────────────────────────────────────

/**
 * Fully-typed shape of every known setting. Consumers always receive a complete
 * object (missing DB rows fall back to the defaults below), so no consumer has
 * to handle an "absent key" case.
 */
export interface SettingsValues {
  /** Days a "На място" order is held after being marked ready (spec default 7). */
  default_pickup_deadline_days: number;
  /** Physical store address (storefront pickup + tracking + emails). */
  store_address: string;
  /** Human-readable opening hours, e.g. "Пон–Пет: 9:00–18:00, Сб: 10:00–14:00". */
  store_hours: string;
  /** Public shop phone (tel: link at ready-for-pickup + emails). */
  store_phone: string;
  /** Public shop contact email (mailto: link + emails). */
  store_email: string;
  /** Where admin notices are sent (new orders, cancellations, expiries). Private. */
  admin_notification_email: string;
}

export type SettingKey = keyof SettingsValues;

/** Per-key validation schema (used by the admin PATCH to validate one value). */
export const SETTING_SCHEMAS: Record<SettingKey, z.ZodType> = {
  default_pickup_deadline_days: z
    .number()
    .int("Трябва да е цяло число.")
    .min(1, "Минимум 1 ден.")
    .max(60, "Максимум 60 дни."),
  store_address: freeText(200),
  store_hours: freeText(200),
  store_phone: phoneField(40),
  store_email: emailField(160),
  admin_notification_email: emailField(160),
};

/** Safe defaults for any key absent from the DB (the seed populates real ones). */
export const SETTINGS_DEFAULTS: SettingsValues = {
  default_pickup_deadline_days: 7,
  store_address: "",
  store_hours: "",
  store_phone: "",
  store_email: "",
  admin_notification_email: "",
};

/**
 * Keys exposed by the PUBLIC GET /settings (the storefront footer / contact
 * block + the guest tracking contact). The two operational keys
 * (default_pickup_deadline_days, admin_notification_email) are admin-only — they
 * never reach an anonymous response.
 */
export const PUBLIC_SETTING_KEYS = [
  "store_address",
  "store_hours",
  "store_phone",
  "store_email",
] as const satisfies readonly SettingKey[];

export type PublicSettingKey = (typeof PUBLIC_SETTING_KEYS)[number];
export type PublicSettings = Pick<SettingsValues, PublicSettingKey>;

export const ALL_SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS) as SettingKey[];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key);
}

export type ValidateResult =
  | { ok: true; value: SettingsValues[SettingKey] }
  | { ok: false; message: string };

/**
 * Validate + normalise one setting value against its registry schema. Returns
 * the cleaned value (trimmed, control-char-stripped, type-coerced) or a
 * human-readable Bulgarian message. The admin PATCH calls this per supplied key
 * and turns a failure into a field-level 400.
 */
export function validateSetting(key: SettingKey, raw: unknown): ValidateResult {
  const parsed = SETTING_SCHEMAS[key].safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: first?.message ?? "Невалидна стойност." };
  }
  return { ok: true, value: parsed.data as SettingsValues[SettingKey] };
}

/**
 * Merge raw DB rows over the defaults into a complete, typed settings object.
 * Defensive by design: a row whose stored JSON no longer matches its schema
 * (e.g. a legacy shape from before a registry change) falls back to the default
 * for that key rather than throwing — a single malformed row can never take down
 * a public read. Unknown keys in the DB are ignored.
 */
export function coerceSettings(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
): SettingsValues {
  const result: SettingsValues = { ...SETTINGS_DEFAULTS };
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    const parsed = SETTING_SCHEMAS[row.key].safeParse(row.value);
    if (parsed.success) {
      // Each schema's output type matches SettingsValues[key]; the index write
      // is sound but TS can't prove the correlated-key relationship.
      (result as Record<SettingKey, unknown>)[row.key] = parsed.data;
    }
  }
  return result;
}

/** Project the public subset for the anonymous GET /settings response. */
export function pickPublic(values: SettingsValues): PublicSettings {
  return {
    store_address: values.store_address,
    store_hours: values.store_hours,
    store_phone: values.store_phone,
    store_email: values.store_email,
  };
}
