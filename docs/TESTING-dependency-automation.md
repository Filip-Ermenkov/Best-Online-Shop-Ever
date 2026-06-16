# Testing — automated dependency management (Dependabot + `npm audit` gate)

Step-by-step verification for the 2026-06-16 supply-chain slice:
`.github/dependabot.yml` (automated version updates) and the new `audit`
job in `.github/workflows/ci.yml` (the `npm audit` gate).

Follow the phases in order. Commands are PowerShell from the repo root
unless noted. "the repo on GitHub" = `github.com/<you>/Best-Online-Shop-Ever`.

What shipped (the surface under test):

- `.github/dependabot.yml` — five update entries: **npm** (`/`), **github-actions**
  (`/`), **terraform** (`/infra`), **terraform** (`/infra/bootstrap`),
  **docker-compose** (`/backend/db`). Grouped PRs, `cooldown`, Sofia schedule,
  Postgres-major ignored.
- `.github/workflows/ci.yml` — new `audit` job (informational full audit +
  blocking critical-only gate on production deps).
- Docs reconciled: `README.md` (CI table now six jobs), `docs/ARCHITECTURE.md`
  (§9.1, new §9.6, §9.4 required-checks, §13 bullet), `docs/COMPLIANCE.md`
  (SCA + A03 rows).

---

## Phase 0 — One-time GitHub settings (required for Dependabot to run)

Dependabot *version updates* read the dependency graph; the config file alone
isn't enough if the graph/alerts are off. Confirm these are ON:

1. On GitHub: **repo → Settings → Advanced Security** (older UI: **Settings →
   Code security and analysis**).
2. Verify **Dependency graph** = Enabled.
3. Verify **Dependabot alerts** = Enabled.
4. Verify **Dependabot security updates** = Enabled (this is what makes the
   `*-security` groups in the config open PRs for CVEs).

> If the repo is private, also confirm Dependabot has the access it needs
> (same page). For a public repo the defaults are already correct.

No file changes here — just confirm the toggles.

---

## Phase 1 — Local pre-push checks (catch problems before CI)

### 1.1 — Validate the Dependabot YAML parses

Use the YAML parser already in `node_modules` (no extra install — and unlike
`python -c "import yaml"`, this needs no PyYAML):

```powershell
node -e "const y=require('js-yaml'),fs=require('fs');const d=y.load(fs.readFileSync('.github/dependabot.yml','utf8'));console.log('version',d.version,'| entries',d.updates.length)"
```

**Expected:** `version 2 | entries 5` and no error.

> GitHub is the *authoritative* validator: after you push, **repo → Insights →
> Dependency graph → Dependabot** shows a red banner naming any bad key/line.
> The local check above is just a fast pre-push sanity pass.

### 1.2 — Run the CI audit gate exactly as CI will

```powershell
# 1) Informational (what CI prints but never fails on):
npm audit --omit=dev

# 2) The BLOCKING gate (what CI fails the PR on). The EXIT CODE is the signal,
#    not the printout — `--audit-level` controls only the exit code; npm audit
#    ALWAYS prints every advisory it finds, so seeing the full list is normal.
npm audit --omit=dev --audit-level=critical
# read the exit code — pick the line for YOUR shell:
#   cmd.exe     →  echo %ERRORLEVEL%
#   PowerShell  →  $LASTEXITCODE
```

> Shell trap: `$LASTEXITCODE` is a PowerShell variable. In `cmd.exe` it echoes
> literally — use `echo %ERRORLEVEL%` there.

**Expected today (verified against the current lockfile):**

- Production severity counts are `low:1, moderate:6, high:4, **critical:0**`.
- Step 1 prints those advisories (e.g. `drizzle-orm`, `hono`, `next`, `qs`) —
  that is the informational view and **fails nothing**.
- Step 2 prints the **same** list (see the note above — that's expected) but
  the **exit code is `0`**, so the gate passes and CI's `audit` job is green.
  Gating on `high` instead would exit `1` (red) because of the 4 highs — which
  is exactly why the gate is critical-only. Those highs are Dependabot's job to
  clear via reviewed (often breaking) upgrade PRs, not this gate's.
- If step 2 ever exits non-zero, a genuine **critical** landed in the production
  tree — that is the gate doing its job; fix or upgrade before merge.

### 1.3 — Confirm nothing else regressed

```powershell
npm ci
npm run typecheck --workspaces --if-present
npm --workspace shop run lint
# (full test suites if you want the whole gate — needs Docker for the API DB)
# npm run db:up; npm --workspace @shop/api run test
```

**Expected:** typecheck + lint pass exactly as before. The dependency-automation
slice changes **no application code**, so these cannot be affected by it — this
step just proves the working tree is clean before you push.

---

## Phase 2 — Push a branch and verify the CI `audit` job

1. Create a branch, commit the four areas (config + workflow + docs), push, open
   a PR to `main`:

   ```powershell
   git checkout -b chore/dependency-automation
   git add .github/dependabot.yml .github/workflows/ci.yml README.md docs/ARCHITECTURE.md docs/COMPLIANCE.md docs/TESTING-dependency-automation.md
   git commit -m "chore(supply-chain): automate dependency updates (Dependabot) + npm audit CI gate; reconcile §9 docs"
   git push -u origin chore/dependency-automation
   ```
   Then open the PR on GitHub.

2. On the PR → **Checks** (or the status list at the bottom): confirm a new
   check named **`Dependency audit (npm)`** appears alongside the existing five
   (`Typecheck (all workspaces)`, `Lint (frontend)`, `Auth tests`,
   `Email tests`, `API tests (Postgres)`).

3. Click **`Dependency audit (npm)` → Details**. Confirm:
   - The step **"Audit (informational — all severities, never blocks)"** runs and
     shows advisories but is marked successful (the `|| true`).
   - The step **"Audit gate (fail the PR on CRITICAL advisories…)"** runs and
     **passes** (exit 0).
   - Overall the job is **green**.

**Expected:** the PR shows six green checks. If the workflow YAML had a syntax
error, GitHub would surface it in the **Actions** tab as a workflow-parse failure
instead — you should see none.

---

## Phase 3 — Verify Dependabot picked up the config (don't wait for Monday)

1. On GitHub: **repo → Insights → Dependency graph → Dependabot** tab.
   (Direct URL: `…/network/updates`.)

2. **Expected:** five rows, one per entry, each showing its manifest path and
   "Last checked …":
   - `npm` — `/package-lock.json` (or `/`)
   - `github-actions` — `/.github/workflows`
   - `terraform` — `/infra`
   - `terraform` — `/infra/bootstrap`
   - `docker-compose` — `/backend/db`

3. **If the config has an error**, this page shows a red banner naming the bad
   key/line instead of the rows — there should be none.

4. Force an immediate run instead of waiting for the Monday 06:00 Europe/Sofia
   schedule: on each row click **"Last checked … — Check for updates"**. This
   makes Dependabot evaluate that ecosystem now.

> Alternative trigger: **Insights → Dependency graph → Dependabot → "Recent
> update jobs"** shows each run's log; useful if a PR you expected didn't appear.

---

## Phase 4 — Inspect the first real Dependabot PRs

After Phase 3's manual runs (give it a few minutes), check **Pull requests** and
the **`dependencies`** label.

Verify the behaviors that prove the config is doing what we designed:

- **Grouping.** Updates arrive as a few grouped PRs (e.g. one
  "npm-development" PR), not one PR per package. Title/branch reflect the group
  name.
- **Commit-message prefixes** match the repo convention:
  `chore(deps)` / `chore(deps-dev)` (npm), `ci(actions)` (Actions),
  `infra(deps)` (Terraform), `chore(docker)` (Docker-Compose).
- **SHA-pin + comment bump (Actions).** Open any `ci(actions)` PR and look at the
  diff for a pinned action. Confirm **both** the 40-char SHA **and** the trailing
  `# vX.Y.Z` version comment are updated together — the pin stays secure *and*
  readable.
  - Known cosmetic caveat: for the multi-line named pins written as
    `# actions/checkout v6.0.2 — 09 Jan 2026`, Dependabot updates the **version**
    token but leaves the **date** as-is. The inline `# v6.0.2` end-of-line pins
    update fully. The SHA — the security-relevant part — is always correct.
- **Cooldown.** A dependency whose newest release is only a day or two old is
  *not* proposed yet (it's inside the 5–14-day window). A release older than the
  window is. You can sanity-check by comparing a skipped bump against the
  package's release date on npm.
- **Each PR is gated.** Every Dependabot PR runs the full six-job CI (including
  the new `audit` job), so a bump that introduced a critical advisory or broke a
  test cannot merge green.

---

## Phase 5 — (Optional) Add the new required status check to branch protection

Per `docs/ARCHITECTURE.md` §9.4, if/when branch protection is enabled on `main`:

1. **repo → Settings → Branches → Branch protection rules → `main` → Edit**.
2. Under **Require status checks to pass before merging**, add
   **`Dependency audit (npm)`** to the required list (it joins
   `API tests (Postgres)` et al.).
3. Save.

> Gotcha (also in §9.4): don't add a `paths:`/`paths-ignore:` filter to `ci.yml`'s
> `pull_request:` trigger while `Dependency audit (npm)` is required — a workflow
> that doesn't fire never reports, and the PR hangs on "Waiting for status."

---

## Phase 6 — Negative / edge checks (prove the guardrails)

- **Postgres major is pinned.** Dependabot must **never** open a PR bumping
  `postgres` from `17-alpine` to `18`/`19` (the `ignore` rule). It *may* offer a
  `17.x` patch/minor. Confirm no major-bump PR appears for the
  `docker-compose @ /backend/db` entry.
- **Security beats cooldown (conceptual).** Cooldown delays *version* updates
  only. If a CVE is published for a current dependency, the matching `*-security`
  group opens a PR **immediately**, regardless of cooldown. You can't force a CVE,
  but you can confirm the design by reading the two `applies-to:` blocks per
  ecosystem in `.github/dependabot.yml`.
- **Audit gate fails on a real critical (optional, destructive — do on a throwaway
  branch).** To see the gate go red, temporarily add a package-lock entry for a
  package with a known critical advisory, push, and watch `Dependency audit (npm)`
  fail at the blocking step. Revert the branch afterward. (Skip unless you want
  to see red on purpose.)

---

## Done — what "green" looks like

- Phase 1: local `--audit-level=critical` exits 0; YAML parses.
- Phase 2: PR shows **six** green checks, including `Dependency audit (npm)`.
- Phase 3: Dependabot tab lists **five** ecosystem rows, no config error.
- Phase 4: grouped, correctly-prefixed PRs appear; an Actions PR bumps SHA +
  comment together; very-fresh releases are held by cooldown.
- Phase 6: no Postgres-major PR ever appears.

If all of the above hold, the active half of software-composition analysis is
live and the §9.1 `npm audit` claim is now true.
