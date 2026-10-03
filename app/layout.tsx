import type { Metadata } from "next";
import "./globals.css";
import AnonymousSessionBootstrap from "@/components/anonymous-session-bootstrap";

export const metadata: Metadata = {
  title: "Tradumanga — Tradução contextual",
  description: "Tradução contextual de mangás e manhwas para português.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="pt-BR"><body><AnonymousSessionBootstrap />{children}</body></html>;
}
