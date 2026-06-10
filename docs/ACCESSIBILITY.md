# Accessibility — WCAG 2.2 AA / European Accessibility Act

> Engineering-facing companion to `COMPLIANCE.md` §13. That section is the
> auditor-facing status row; this doc is the *how*: the standard we target, the
> layered audit that keeps us there, the design-token rationale, the manual
> checklist automation can't replace, and the honest list of known gaps.
>
> Customer-facing statement: `/accessibility` (Bulgarian-primary, EAA Annex V).
> This doc is the internal detail behind it.
>
> Last updated: 2026-06-02.

---

## 1. What applies and why

The shop is a B2C/B2B e-commerce service sold to consumers in Bulgaria (an EU
member state). That puts it squarely inside the **European Accessibility Act**
(Directive (EU) 2019/882), **enforceable since 28 June 2025**. Enforcement is
real and already happening across the EU (formal legal notices and injunctions
against non-compliant retailers in 2025), and penalties run to the low millions
of euro plus removal-from-market powers.

The harmonised technical standard is **EN 301 549**. Its current revision maps
to **WCAG 2.1 AA**; the V4.x revision in progress for 2026 brings **WCAG 2.2
AA**. We target **WCAG 2.2 AA**, which is a *superset* of 2.1 AA — so we satisfy
the operative benchmark today and the incoming one at the same time.

This is also the project's most overdue compliance item relative to its own
posture: the shop ships the EU 2023/2673 14-day withdrawal directive *ahead* of
its 19 June 2026 deadline, while accessibility — legally due ~12 months
*earlier* — had sat at ⚠️ across all four WCAG principles until this slice.

---

## 2. The layered audit (continuous)

Automated tooling catches an estimated **30–40%** of WCAG issues. The rest needs
a human. So the audit is deliberately layered, cheapest-first, so manual effort
is spent only on what machines can't see.

| Layer | Tool | Runs | Catches |
|---|---|---|---|
| Static | `eslint-plugin-jsx-a11y` | **CI, every PR** (the existing `lint` job) | Missing alt text, bad ARIA roles/props, label-less controls, click handlers on non-interactive elements |
| Runtime | `axe-core` via Playwright (`tests/a11y/axe.spec.ts`) | Local / pre-push (`npm run test:a11y`) | Computed colour contrast, focus order, ARIA against the live a11y tree, reflow |
| Manual | Keyboard + screen reader | Per significant UI change (checklist §5) | Logical focus order, meaningful sequence, SR announcements, "does it actually make sense" |

### Running them

```bash
# Static (also part of CI):
npm --workspace shop run lint

# Runtime axe scan (boots the Next dev server automatically):
cd frontend
npm run test:a11y:install   # one-time: fetch the Chromium binary
npm run test:a11y           # scans the pages in tests/a11y/axe.spec.ts
```

The runtime scan defaults to pages that render without a seeded catalogue API
(the `(shop)` layout swallows a tree-fetch error and renders an empty tree), so
it produces signal even with only the dev server up. For a **full** pass, bring
up `shop-api` + a seeded Postgres and extend `PAGES` in the spec to cover the
catalogue, cart and checkout routes, then point the run at it:

```bash
A11Y_BASE_URL=http://localhost:3000 npm run test:a11y
```

### Why the runtime scan isn't a hard CI job (yet)

Same reason `next build` isn't in CI (see `README.md` → Continuous
integration): a faithful run wants the API + a seeded DB beside the Next server.
It's a **local/pre-push gate** until a build-time API stub exists, at which point
both `next build` and `test:a11y` can graduate to CI together. The static
`jsx-a11y` layer *is* in CI today and is the automated regression gate.

### eslint rule severities

`eslint.config.mjs` hardens the rules we have **verified the tree passes** to
`error` (so a regression fails the build) and keeps deeper rules at `warn` as a
backlog signal (promote to `error` after a confirmed-green local lint run).
Every `autoFocus` was removed from the customer-facing pages (the lint runs at
**zero warnings**); `jsx-a11y/no-autofocus` stays at `warn` to flag any
reintroduction. The two label heuristics (`control-has-associated-label`,
`label-has-associated-control`) are scoped **off for `src/app/admin/**`** — the
admin panel is operator-only and out of scope for the customer conformance, and
there they fire only on empty action-column `<th>` cells and on checkboxes
already labelled via the design-system `<Label>` the rule can't follow. The one
remaining customer-facing false positive (the `<Label>` primitive itself) is
suppressed with an inline `eslint-disable` + rationale at its definition.

---

## 3. Design-token rationale (the contrast fix)

The "luxury" palette's brand gold — `--primary: oklch(0.73 0.10 75)` (~#C9A96E)
— is only **2.4:1** on white. That's fine as a **fill** behind dark text
(charcoal-on-gold is 7.8:1) but a **WCAG 1.4.3 failure** as small text. The grey
`--muted-foreground` was `oklch(0.60 …)` = **3.95:1**, also a fail for normal
text. Both were used pervasively (prices, links, secondary copy).

Fix — keep the brand fills, split out accessible text colours:

| Token | Before | After | On white | Used for |
|---|---|---|---|---|
| `--primary` | `oklch(0.73 0.10 75)` | unchanged | 2.4:1 (fill only) | CTA/button **backgrounds** (dark text on top) |
| `--primary-strong` (new) | — | `oklch(0.52 0.12 75)` | **5.6:1** | gold **text/links/icons**; `text-primary-strong` |
| `--muted-foreground` | `oklch(0.60 0.02 270)` | `oklch(0.52 0.02 270)` | **5.5:1** (4.9 on muted) | secondary text |
| `--ring` | `oklch(0.73 0.10 75)` | `oklch(0.52 0.12 75)` | **5.6:1** | focus indicator (also clears 1.4.11/2.4.13) |

Dark theme gets the mirror treatment (`--muted-foreground` → 0.72,
`--primary-strong` → 0.80). Every pair was verified computationally
(OKLCH→linear-sRGB→WCAG luminance); see the contrast script referenced in the
slice notes. Every bare `text-primary` used as text was swept to
`text-primary-strong`; the brand gold remains only on fills and on dark
surfaces (the navbar/footer, where gold-on-charcoal is already 7.8:1).

Two more colour fixes were surfaced by the runtime axe scan (not the static
layer — proof the layering earns its keep):

- **Status green (1.4.3):** `text-green-600` (#16a34a) is **3.30:1** on white —
  a fail as text. Moved to `text-green-700` (#15803d, **5.02:1**); still clears
  3:1 for the icon usages.
- **Links in prose (1.4.1 Use of Colour):** gold text-links inside sentences
  were distinguished by colour alone. They now carry a **persistent
  `underline`** (was `hover:underline`), scoped to the gold links so the
  accordion trigger and other hover-underline affordances are untouched.
- **Target size (2.5.8):** the banner-carousel dots were 6 px tall; each is now
  a ≥ 24 × 24 px button with the small visual indicator centred inside.

---

## 4. WCAG 2.2 AA — new success criteria status

The five criteria WCAG 2.2 added at A/AA (2.4.11, 2.4.13, 2.5.7, 2.5.8, 3.3.7 —
3.3.8 Accessible Authentication is AA; 2.4.12/3.3.9 are AAA):

| SC | Level | Status | Notes |
|---|---|---|---|
| 2.4.11 Focus Not Obscured (Min) | AA | ✅ | No sticky overlays cover focused controls except the header; focused content scrolls clear. |
| 2.4.13 Focus Appearance | AA | ✅ | 2px solid `--ring` outline + 2px offset on `:focus-visible`; primitives also carry a 3px ring. |
| 2.5.7 Dragging Movements | AA | ✅ | No drag-only interactions on the storefront. (The admin DnD ordering is out of scope — operator-only.) |
| 2.5.8 Target Size (Min) | AA | ✅ | Interactive targets ≥ 24×24 CSS px (button `xs`/icon sizes are exactly 24px floor; most are 28–36px). |
| 3.3.7 Redundant Entry | A | ✅ | No flow re-asks for the same data within a step. |
| 3.3.8 Accessible Authentication (Min) | AA | ✅ | Password auth allows paste; no cognitive-function test (no CAPTCHA, no transcription). |

---

## 5. Manual checklist (run on significant UI changes)

Automated layers can't judge *meaningful sequence* or *does this announce
sensibly*. Walk these by hand.

**Keyboard only (unplug the mouse):**

- [ ] `Tab` from the very top first lands on **Skip to content**; activating it
      moves focus to `#main-content`.
- [ ] Every interactive element is reachable and shows a **visible focus ring**.
- [ ] No keyboard trap; `Tab`/`Shift+Tab` order matches visual order.
- [ ] Search box: type ≥ 2 chars → `ArrowDown`/`ArrowUp` move the highlight,
      `Enter` opens the highlighted product, `Escape` closes the list.
- [ ] Cart drawer / filter drawer / dialogs: focus moves in on open, `Escape`
      closes, focus returns to the trigger.
- [ ] Product card: the title link is tabbable; the quantity steppers and
      Add-to-cart are independently focusable (no nested-interactive trap).

**Screen reader (VoiceOver / NVDA):**

- [ ] Page has one `<h1>`; heading levels don't skip.
- [ ] Form fields announce their label; errors announce via `role="alert"`.
- [ ] Icon-only buttons announce a meaningful name (cart, account, close = "Затвори").
- [ ] Images have meaningful `alt`; decorative images are silent (`alt=""`).
- [ ] Landmarks present: `header`/`nav`/`main`/`footer`.

**Visual / motion:**

- [ ] Zoom to 200% (and 400% reflow): no loss of content/function, no horizontal scroll at 320px CSS width.
- [ ] OS "reduce motion" on → no shimmer/slide/scale animation, no smooth-scroll.
- [ ] Information is never conveyed by colour alone (links underline or carry text/an icon).

---

## 6. Known limitations (honest)

- **Category menu — no full `menubar` keyboard model.** Every category is
  keyboard-reachable: the "Всички категории" panel is a button
  (`Escape`-closable, every link inside focusable), and the visible-root
  previews now open on **keyboard focus** as well as hover (`onFocus`/`onBlur`
  on the hover-zone, where `onBlur` only closes when focus leaves the whole
  zone via a `relatedTarget` check; plus `group-focus-within` on the nested
  fly-outs). What's *not* implemented is the full WAI-ARIA APG `menubar` model
  — roving `tabindex` and arrow-key traversal between top-level items. Content
  parity is complete; the richer menubar keyboard shortcuts are the remaining
  enhancement. The hover-zone wrapper carries a documented
  `eslint-disable jsx-a11y/no-static-element-interactions` (it wraps a native
  `<Link>`, so it takes no interactive role of its own).
- **Admin panel** (`/admin/*`) is operator-only and out of scope for the
  customer statement. The admin **sign-in gate** (`AdminAuthGate`, login →
  MFA → TOTP enrolment) and the admin **orders** screens
  (`OrdersExplorer` + `OrderDetailPanel`, 2026-06-10) are real and *are*
  linted by `jsx-a11y` (they live under `src/components/admin/`, outside
  the `src/app/admin/**` lint exclusion — labelled filter controls, live-
  region errors and conflict notices, `aria-hidden` decorative icons, an
  inline — not focus-trapped — confirmation step, and the expired-deadline
  state conveyed by icon + text, not colour alone). The remaining CRUD
  pages are still on mock data; the panel as a whole has not had a full
  screen-reader audit.
- **Third-party content** (courier-office maps) will be assessed when ingested.

---

## 7. References

- European Accessibility Act — Directive (EU) 2019/882 (Annex I requirements; Annex V statement).
- EN 301 549 — harmonised European accessibility standard.
- WCAG 2.2 (W3C Recommendation) — Level AA.
- WAI-ARIA Authoring Practices Guide — Combobox pattern (search field).
- `eslint-plugin-jsx-a11y`, `@axe-core/playwright` — the automated layers.
