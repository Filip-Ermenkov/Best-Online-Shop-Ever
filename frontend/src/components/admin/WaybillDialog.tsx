"use client";

import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Order } from "@/lib/types";

interface WaybillDialogProps {
  order: Order;
}

export default function WaybillDialog({ order }: WaybillDialogProps) {
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [form, setForm] = useState({
    recipientName: order.deliveryAddress?.name ?? "",
    phone: order.deliveryAddress?.phone ?? "",
    address: order.courierInfo
      ? (order.deliveryAddress ? `${order.deliveryAddress.street}, ${order.deliveryAddress.city}` : "")
      : "",
    weight: "1",
    notes: "",
  });

  function setField(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await new Promise((r) => setTimeout(r, 800));
    setSuccess(true);
    setTimeout(() => {
      setSuccess(false);
      setOpen(false);
    }, 2000);
  }

  const courierName = order.courierInfo?.company ?? "Куриер";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" className="gap-2" onClick={() => setOpen(true)}>
        <Printer className="w-4 h-4" />
        Създай товарителница
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Товарителница — {courierName}</DialogTitle>
        </DialogHeader>
        {success ? (
          <div className="py-8 text-center">
            <p className="text-green-700 font-semibold text-lg">✓ Товарителницата е създадена!</p>
            <p className="text-sm text-muted-foreground mt-1">Поръчка {order.orderNumber}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div>
              <Label htmlFor="wb-name">Получател</Label>
              <Input id="wb-name" value={form.recipientName} onChange={(e) => setField("recipientName", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="wb-phone">Телефон</Label>
              <Input id="wb-phone" value={form.phone} onChange={(e) => setField("phone", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="wb-address">Адрес / Офис</Label>
              <Input id="wb-address" value={form.address} onChange={(e) => setField("address", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="wb-weight">Тегло (кг)</Label>
              <Input id="wb-weight" type="number" min="0.1" step="0.1" value={form.weight} onChange={(e) => setField("weight", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="wb-notes">Бележки</Label>
              <Textarea id="wb-notes" value={form.notes} onChange={(e) => setField("notes", e.target.value)} rows={2} className="mt-1 resize-none" placeholder="Допълнителни инструкции..." />
            </div>
            <Button type="submit" className="w-full">Създай товарителница</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
