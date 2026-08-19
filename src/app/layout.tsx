import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TikWiki — um artigo interessante por vez",
  description:
    "Descubra artigos peculiares e fascinantes da Wikipédia, um de cada vez.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
