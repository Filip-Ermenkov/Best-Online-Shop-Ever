import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Runtime accessibility audit (WCAG 2.2 AA / European Accessibility Act).
 *
 * The RUNTIME half of the layered audit described in COMPLIANCE.md §13. The
 * static half (eslint-plugin-jsx-a11y) runs in CI on every PR and catches
 * structural issues in the JSX; this half boots a real browser and runs
 * axe-core against rendered pages, catching what static analysis cannot:
 * computed colour contrast (the whole reason the gold/grey design tokens were
 * darkened), focus order, ARIA evaluated against the live accessibility tree,
 * and reflow.
 *
 * Tag set mirrors the legal benchmark: EN 301 549 currently maps to WCAG 2.1
 * AA, and the shop targets 2.2 AA (a superset), so we assert against A + AA at
 * every published WCAG level axe knows about. axe-core covers ~30–40% of WCAG
 * automatically — the remainder lives in docs/ACCESSIBILITY.md's manual
 * keyboard + screen-reader checklist.
 *
 * Page list is deliberately the set that renders WITHOUT a seeded catalogue API
 * (the (shop) layout swallows a category-tree fetch error and renders an empty
 * tree), so the audit produces signal even when only the Next dev server is up.
 * For a full pass, run the shop-api + a seeded Postgres alongside and add the
 * catalogue / cart / checkout routes to PAGES.
 */

const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

const PAGES: { path: string; name: string }[] = [
  { path: "/", name: "Home" },
  { path: "/account/login", name: "Login" },
  { path: "/account/register", name: "Register" },
  { path: "/account/forgot-password", name: "Forgot password" },
  { path: "/accessibility", name: "Accessibility statement" },
  { path: "/security", name: "Security / VDP" },
  { path: "/terms", name: "Terms" },
  { path: "/terms/withdrawal", name: "Withdrawal terms" },
  { path: "/privacy", name: "Privacy" },
  { path: "/delivery", name: "Delivery & returns" },
  { path: "/faq", name: "FAQ" },
  { path: "/contact", name: "Contact" },
  { path: "/about", name: "About" },
];

async function runAxe(page: Page) {
  return new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
}

function formatViolations(results: Awaited<ReturnType<typeof runAxe>>): string {
  return results.violations
    .map((v) => {
      const where = v.nodes
        .slice(0, 4)
        .map((n) => `        ${n.target.join(" ")}`)
        .join("\n");
      return `  • [${v.impact}] ${v.id}: ${v.help}\n      ${v.helpUrl}\n${where}`;
    })
    .join("\n\n");
}

for (const { path, name } of PAGES) {
  test(`${name} (${path}) has no WCAG 2.2 AA violations`, async ({ page }) => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const results = await runAxe(page);
    expect(
      results.violations.length,
      results.violations.length === 0
        ? "no violations"
        : `\n${formatViolations(results)}\n`,
    ).toBe(0);
  });
}

test("Login: keyboard reaches the skip link first, then it targets #main-content", async ({
  page,
}) => {
  await page.goto("/account/login", { waitUntil: "domcontentloaded" });
  // First Tab from the top of the document should land on the skip link.
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { text: el?.textContent?.trim(), href: el?.getAttribute("href") };
  });
  expect(focused.href).toBe("#main-content");
  // And the target it points at must exist and be focusable.
  const target = page.locator("#main-content");
  await expect(target).toHaveAttribute("tabindex", "-1");
});
