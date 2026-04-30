/**
 * Local development seed.
 *
 * Goals:
 *   - Idempotent: running this twice does not create duplicates. We use ON
 *     CONFLICT DO NOTHING + stable slugs/codes/emails.
 *   - Realistic: data shape matches what the frontend already expects so the
 *     UI can be exercised end-to-end with the dev DB pointed at this seed.
 *   - Minimal: 3 categories × 3 products + 1 admin + 1 customer is enough to
 *     prove every read path.
 *
 * Run AFTER db:migrate. The migration creates the tables; this populates them.
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import * as s from "./schema/index";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  // Force node-postgres so we can use ON CONFLICT — the HTTP driver supports it
  // but local dev typically points at the Docker Postgres.
  const db = createDb({ databaseUrl, driver: "node-postgres" });

  console.log("Seeding...");

  // ─── Categories ──────────────────────────────────────────────────────────
  const [electronics, tools, home] = await db
    .insert(s.categories)
    .values([
      { slug: "electronics", name: "Електроника", displayOrder: 0 },
      { slug: "tools", name: "Инструменти", displayOrder: 1 },
      { slug: "home", name: "Дом", displayOrder: 2 },
    ])
    .onConflictDoNothing({ target: [s.categories.parentId, s.categories.slug] })
    .returning();

  // After ON CONFLICT we may have empty returning() — re-fetch to get IDs
  const allCategories = await db.select().from(s.categories);
  const electronicsId =
    electronics?.id ??
    allCategories.find((c) => c.slug === "electronics")?.id;
  const toolsId = tools?.id ?? allCategories.find((c) => c.slug === "tools")?.id;
  const homeId = home?.id ?? allCategories.find((c) => c.slug === "home")?.id;

  if (!electronicsId || !toolsId || !homeId) {
    throw new Error("Failed to seed categories");
  }

  // ─── Products ────────────────────────────────────────────────────────────
  await db
    .insert(s.products)
    .values([
      {
        slug: "wireless-headphones",
        code: "WH-001",
        name: "Безжични слушалки",
        description: "Bluetooth 5.3, 30 часа автономност, активно шумопотискане.",
        priceCents: "12999", // €129.99
        categoryId: electronicsId,
        stockStatus: "in_stock",
        displayOrder: 0,
      },
      {
        slug: "smart-watch",
        code: "SW-002",
        name: "Смарт часовник",
        description: "AMOLED дисплей, GPS, водоустойчив до 50 метра.",
        priceCents: "24999", // €249.99
        categoryId: electronicsId,
        stockStatus: "in_stock",
        displayOrder: 1,
      },
      {
        slug: "drill-set",
        code: "TL-003",
        name: "Комплект бормашина",
        description: "18V Li-ion, 50 Nm въртящ момент, 2 батерии в комплекта.",
        priceCents: "15999", // €159.99
        categoryId: toolsId,
        stockStatus: "in_stock",
        displayOrder: 0,
      },
    ])
    .onConflictDoNothing({ target: s.products.code });

  // ─── Settings (single source of truth for store config) ──────────────────
  await db
    .insert(s.settings)
    .values([
      { key: "default_pickup_deadline_days", value: 7 },
      {
        key: "store_address",
        value: "ул. Витоша 15, София 1000",
      },
      {
        key: "store_hours",
        value: {
          mon_fri: "9:00-18:00",
          sat: "10:00-14:00",
          sun: "closed",
        },
      },
      { key: "store_phone", value: "+359 2 900 1234" },
      { key: "store_email", value: "info@duda1.bg" },
    ])
    .onConflictDoNothing({ target: s.settings.key });

  // ─── Initial ToS version 1 ───────────────────────────────────────────────
  await db
    .insert(s.tosVersions)
    .values({
      versionNumber: 1,
      contentMd:
        "# Условия за ползване\n\nПлейсхолдер. Замени през административния панел.",
    })
    .onConflictDoNothing({ target: s.tosVersions.versionNumber });

  // Privacy policy single row
  await db
    .insert(s.privacyPolicy)
    .values({ contentMd: "# Политика за поверителност\n\nПлейсхолдер." })
    .onConflictDoNothing();

  // ─── A demo admin and a demo customer ────────────────────────────────────
  // Password = "DemoPass1" hashed with Argon2id.
  // Hash is precomputed so the seed has zero crypto dependencies.
  // To regenerate: `argon2 -h "DemoPass1"` with default params, or use the
  // backend auth helper once that package exists.
  const ARGON2_DEMO_HASH =
    "$argon2id$v=19$m=65536,t=3,p=1$SeedSeedSeedSeed$WkS0BzoTxmW1dj/A77MxEMfRUtoTFLi5MQjs/IGmVes";

  await db
    .insert(s.users)
    .values([
      {
        email: "admin@shop.bg",
        passwordHash: ARGON2_DEMO_HASH,
        role: "admin",
        emailVerifiedAt: sql`now()`,
      },
      {
        email: "ivan.petrov@example.com",
        passwordHash: ARGON2_DEMO_HASH,
        role: "customer",
        accountType: "personal",
        emailVerifiedAt: sql`now()`,
      },
    ])
    .onConflictDoNothing({ target: s.users.email });

  // Personal profile for the customer
  const ivan = (
    await db
      .select()
      .from(s.users)
      .where(sql`${s.users.email} = 'ivan.petrov@example.com'`)
  )[0];
  if (ivan) {
    await db
      .insert(s.customerProfiles)
      .values({
        userId: ivan.id,
        fullName: "Иван Петров",
        phone: "+359 88 123 4567",
      })
      .onConflictDoNothing();
  }

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
