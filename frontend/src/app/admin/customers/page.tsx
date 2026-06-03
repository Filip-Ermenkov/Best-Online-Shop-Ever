"use client";

import { useState } from "react";
import { customers as initialCustomers } from "@/lib/mock-data/customers";
import { Customer } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

export default function AdminCustomersPage() {
  const [customerList, setCustomerList] = useState<Customer[]>(initialCustomers);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDiscount, setEditDiscount] = useState(0);

  function saveDiscount(id: string) {
    setCustomerList((list) =>
      list.map((c) => (c.id === id ? { ...c, discountPercent: editDiscount } : c))
    );
    setEditingId(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Клиенти</h1>
          <p className="text-sm text-muted-foreground mt-1">{customerList.filter(c => c.isActive).length} активни</p>
        </div>
      </div>

      {/* Desktop table */}
      <div className="rounded-lg border border-border bg-white overflow-hidden hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Клиент</th>
                <th className="text-left px-4 py-3 font-medium">Тип</th>
                <th className="text-left px-4 py-3 font-medium">Регистрация</th>
                <th className="text-left px-4 py-3 font-medium">Отстъпка %</th>
                <th className="text-left px-4 py-3 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody>
              {customerList.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <p className="font-medium">{c.firstName} {c.lastName}</p>
                    <p className="text-xs text-muted-foreground">{c.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    {c.accountType === "corporate"
                      ? <span className="text-xs">{c.companyName}</span>
                      : <span className="text-xs text-muted-foreground">Физическо лице</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(c.createdAt)}</td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number" min={0} max={100}
                          value={editDiscount}
                          onChange={(e) => setEditDiscount(Number(e.target.value))}
                          className="w-16 h-7 text-xs"
                        />
                        <button onClick={() => saveDiscount(c.id)} className="text-xs text-primary-strong underline">Запази</button>
                        <button onClick={() => setEditingId(null)} className="text-xs text-muted-foreground hover:underline">Откажи</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingId(c.id); setEditDiscount(c.discountPercent); }}
                        className="text-sm hover:text-primary-strong transition-colors"
                      >
                        {c.discountPercent}%
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={c.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-600 border-red-200"}>
                      {c.isActive ? "Активен" : "Неактивен"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden space-y-3">
        {customerList.map((c) => (
          <div key={c.id} className="rounded-lg border border-border bg-white p-4 space-y-2">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium">{c.firstName} {c.lastName}</p>
                <p className="text-xs text-muted-foreground">{c.email}</p>
              </div>
              <Badge variant="outline" className={c.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-600 border-red-200"}>
                {c.isActive ? "Активен" : "Неактивен"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {c.accountType === "corporate" ? c.companyName : "Физическо лице"}
              </span>
              <span className="text-muted-foreground">{formatDate(c.createdAt)}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Отстъпка:</span>
              {editingId === c.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number" min={0} max={100}
                    value={editDiscount}
                    onChange={(e) => setEditDiscount(Number(e.target.value))}
                    className="w-16 h-7 text-xs"
                  />
                  <button onClick={() => saveDiscount(c.id)} className="text-xs text-primary-strong underline">Запази</button>
                  <button onClick={() => setEditingId(null)} className="text-xs text-muted-foreground hover:underline">Откажи</button>
                </div>
              ) : (
                <button
                  onClick={() => { setEditingId(c.id); setEditDiscount(c.discountPercent); }}
                  className="text-sm font-medium hover:text-primary-strong transition-colors"
                >
                  {c.discountPercent}%
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
