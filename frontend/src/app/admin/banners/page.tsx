import BannersManager from "@/components/admin/BannersManager";

/**
 * Admin banners — real data via the `/admin/banners` API (the page sits behind
 * the AdminAuthGate rendered by app/admin/layout.tsx). All the interactivity
 * lives in components/admin/BannersManager (jsx-a11y-linted), which uploads the
 * slide image through the shared presigned-POST pipeline (ImageUploadField,
 * kind="banners").
 */
export default function AdminBannersPage() {
  return <BannersManager />;
}
