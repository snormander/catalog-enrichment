import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Catalogue Enrichment — In-house",
  description: "Seller data enrichment, simulation and accuracy evaluation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <h1>Catalogue Enrichment</h1>
          <span className="sub">In-house · seller data QA, simulation &amp; accuracy</span>
        </header>
        {children}
      </body>
    </html>
  );
}
