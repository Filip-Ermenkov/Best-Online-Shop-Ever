"use client";

import { createContext, useContext, useState } from "react";

interface AdminSidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const AdminSidebarContext = createContext<AdminSidebarContextValue>({
  open: false,
  setOpen: () => {},
});

export function AdminSidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <AdminSidebarContext.Provider value={{ open, setOpen }}>
      {children}
    </AdminSidebarContext.Provider>
  );
}

export function useAdminSidebar() {
  return useContext(AdminSidebarContext);
}
