import SettingsManager from "@/components/admin/SettingsManager";

/**
 * /admin/settings — the real store-settings screen (docs/README.md §"Настройки
 * на магазина"). A thin server-component wrapper around the client
 * SettingsManager, which talks to the `/admin/settings` API through the typed
 * client in lib/admin/settings/. Replaces the former mock form (roadmap item 48,
 * the fifth admin CRUD slice).
 */
export default function AdminSettingsPage() {
  return <SettingsManager />;
}
