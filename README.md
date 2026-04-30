# Best-Online-Shop

Online shop project — Bulgarian-language e-commerce platform on AWS.

## Repository layout

```
.
├── frontend/         Next.js 16 app (Amplify Hosting)
├── backend/          Lambda functions (planned: shop-api, admin-api, scheduler)
├── infra/            Terraform IaC (planned)
├── .github/
│   └── workflows/    CI/CD pipelines (planned)
└── docs/
    ├── README.md                     Functional / product specification
    ├── TECHSPEC.md                   AWS infrastructure architecture
    └── AWS_PRICING_RESEARCH_2026.md  Verified rate sheet for cost calculations
```

Each top-level folder is an independent deployable artifact with its own
`package.json` / dependencies / lifecycle. CI uses `paths:` filters per folder
so changes in one don't trigger redeploys of the others.

## Working on the frontend

```bash
cd frontend
npm install
npm run dev
```

Runs at http://localhost:3000.

## Documentation

Read the docs in this order:

1. `docs/README.md` — what the shop does (product spec, in Bulgarian)
2. `docs/TECHSPEC.md` — how it's hosted on AWS (English, with Bulgarian sections)
3. `docs/AWS_PRICING_RESEARCH_2026.md` — verified AWS rates underpinning the cost tables

## Status

- Frontend: UI prototype with mock data, lint/typecheck clean
- Backend: not started
- Infrastructure: not started
- Workflows: not started
