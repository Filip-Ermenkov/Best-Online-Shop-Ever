import { products } from "@/lib/mock-data/products";
import { categories } from "@/lib/mock-data/categories";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RotateCcw } from "lucide-react";

export default function AdminArchivePage() {
  const archivedProducts = products.filter((p) => p.isArchived);
  const archivedCategories = categories.filter((c) => c.isArchived);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Архив</h1>

      <Tabs defaultValue="products">
        <TabsList className="mb-6">
          <TabsTrigger value="products">Продукти ({archivedProducts.length})</TabsTrigger>
          <TabsTrigger value="categories">Категории ({archivedCategories.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          {archivedProducts.length === 0 ? (
            <p className="text-muted-foreground text-sm py-10 text-center">Няма архивирани продукти.</p>
          ) : (
            <div className="rounded-lg border border-border bg-white overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Продукт</th>
                    <th className="text-left px-4 py-3 font-medium">Код</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {archivedProducts.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium">{p.name}</td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{p.code}</td>
                      <td className="px-4 py-3">
                        <Button variant="outline" size="sm" className="gap-1.5">
                          <RotateCcw className="w-3.5 h-3.5" /> Възстанови
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="categories">
          {archivedCategories.length === 0 ? (
            <p className="text-muted-foreground text-sm py-10 text-center">Няма архивирани категории.</p>
          ) : (
            <div className="space-y-2">
              {archivedCategories.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg border border-border bg-white px-4 py-3">
                  <span className="font-medium">{c.name}</span>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <RotateCcw className="w-3.5 h-3.5" /> Възстанови
                  </Button>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
