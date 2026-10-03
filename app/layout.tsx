import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tradumanga — Tradução contextual de mangás",
  description: "Tradução contextual de mangás e manhwas para português, preservando a arte original."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}