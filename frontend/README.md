> **Project note.** This file is the stock `create-next-app` boilerplate and
> intentionally makes no claims about the shop. For what this frontend
> actually implements (storefront, account flows, cart/checkout, guest
> checkout + order tracking, SEO `sitemap.ts`/`robots.ts` + 301 redirect
> serving, admin sign-in + admin orders + admin categories + admin products +
> admin banners with direct-to-S3 image upload + admin store settings + admin
> account management (customer list, per-account B2B discounts, account deletion) +
> the admin dashboard (real operational metrics with an accessible 14-day trend) +
> admin archive & restore (soft-deleted product/category restore + point-in-time
> catalog backups with a one-button manual backup — the last admin page off mock
> data — plus a full **snapshot restore** via a preview + typed-confirm dialog with
> an automatic pre-restore safety backup), the live accessible homepage hero carousel,
> and the settings-driven
> storefront contact block)
> and how to run/test it, see the root `README.md`
> and `docs/ARCHITECTURE.md` §5.

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
