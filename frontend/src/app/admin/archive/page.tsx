import ArchiveManager from "@/components/admin/ArchiveManager";

/**
 * /admin — archive & restore (docs/README.md §12). Thin wrapper: the real screen
 * lives in the client component, wired to the `/admin/archive` API. This was the
 * last admin page on mock data (roadmap item 51).
 */
export default function AdminArchivePage() {
  return <ArchiveManager />;
}
