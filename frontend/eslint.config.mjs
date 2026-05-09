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
]);

export default eslintConfig;
