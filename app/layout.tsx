import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Catalogue Enrichment — Tata CLiQ Fashion",
  description: "Seller data enrichment, simulation and accuracy evaluation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <div className="app-header-inner">
            <div className="app-logo" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="10.5" cy="10.5" r="6.5" stroke="#fff" strokeWidth="2.4" />
                <line x1="15.2" y1="15.2" x2="20" y2="20" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h1>Catalogue Enrichment</h1>
              <div className="sub">Tata CLiQ Fashion · seller data QA &amp; enrichment</div>
            </div>
            <div className="credit">Built by <strong>Zaynah Mahmood</strong> · Catalog Team</div>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
