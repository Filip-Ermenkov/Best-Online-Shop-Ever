import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright a11y specs run under their own toolchain, not next lint.
    "tests/**",
    "playwright.config.ts",
  ]),

  // No project-wide rule severity overrides currently in force.
  //
  // Earlier we'd downgraded `react-hooks/set-state-in-effect` to "warn" as a
  // pragmatic stopgap — the rule (new in eslint-plugin-react-hooks v6 with
  // React 19 / Next 16) flagged six pre-existing patterns we used deliberately.
  // Those have all been addressed:
  //
  //   • Derived state moved to render-time computation (Header search
  //     suggestions, admin-categories slug auto-derive).
  //   • One-time storage reads switched to useSyncExternalStore so the
  //     value is available at render time without an effect (CookieBanner
  //     consent record, /checkout/review draft).
  //   • Genuine "subscribe to external state on mount" patterns (AuthContext
  //     initial /auth/me fetch, CartContext auth-flip mode switching) are
  //     marked with eslint-disable-next-line + a multi-line rationale at
  //     each site.
  //
  // The rule is now back at its default (error) severity, so any future
  // regressions or new violations get caught hard and force a conscious
  // suppress-with-comment decision.

  // ── Accessibility (WCAG 2.2 AA / EAA) — static layer of the continuous
  //    audit (COMPLIANCE.md §13). `eslint-config-next/core-web-vitals` already
  //    runs the jsx-a11y recommended set; this block hardens the rules we have
  //    verified the tree passes (so a regression fails CI) and surfaces the
  //    deeper rules as warnings (a backlog signal, ratchet to "error" once a
  //    full local lint run confirms zero violations). The `jsx-a11y` plugin is
  //    already registered by the next config, so we reference its rules by name
  //    without re-importing it. Runtime checks axe-core can't see statically
  //    (contrast, focus order) are covered by the Playwright job — see
  //    `tests/a11y/` and `npm run test:a11y`.
  {
    rules: {
      // Verified clean across the tree → hard error on regression.
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/mouse-events-have-key-events": "error",
      "jsx-a11y/anchor-is-valid": "error",
      "jsx-a11y/aria-activedescendant-has-tabindex": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      // Deeper rules — kept as warnings until a full lint run is confirmed
      // green, then promote to "error". `no-autofocus`: every `autoFocus` was
      // removed from the customer-facing pages to reach a zero-warning lint;
      // the rule stays at "warn" to flag any reintroduction.
      "jsx-a11y/no-autofocus": "warn",
      "jsx-a11y/label-has-associated-control": "warn",
      "jsx-a11y/control-has-associated-label": "warn",
      "jsx-a11y/no-redundant-roles": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "jsx-a11y/interactive-supports-focus": "warn",
    },
  },

  // The admin panel is operator-only and EXPLICITLY OUT OF SCOPE for the
  // WCAG 2.2 AA / EAA customer conformance (docs/COMPLIANCE.md §13 and the
  // /accessibility statement both say so). It renders mock data today and gets
  // a dedicated a11y audit when the admin-api slice ships (ARCHITECTURE.md §15
  // item 22). The two label heuristics fire there on empty action-column table
  // headers and on checkboxes that ARE labelled via the design-system <Label>
  // (which the rule can't follow) — i.e. noise, not real defects — so they are
  // scoped off here rather than papered over with invented labels.
  {
    files: ["src/app/admin/**/*.tsx"],
    rules: {
      "jsx-a11y/control-has-associated-label": "off",
      "jsx-a11y/label-has-associated-control": "off",
    },
  },
]);

export default eslintConfig;
