"use client";
import React, { useState } from "react";
import EnrichmentSection from "./components/EnrichmentSection";
import EmailSection from "./components/EmailSection";
import ImageStudioSection from "./components/ImageStudioSection";

type Tab = "enrich" | "email" | "studio";

export default function Page() {
  const [tab, setTab] = useState<Tab>("enrich");
  return (
    <>
      <nav className="tabbar">
        <button className="tab" data-active={tab === "enrich"} onClick={() => setTab("enrich")}>
          Enrichment Dashboard
        </button>
        <button className="tab" data-active={tab === "email"} onClick={() => setTab("email")}>
          Fetch from Email <span className="badge">Soon</span>
        </button>
        <button className="tab" data-active={tab === "studio"} onClick={() => setTab("studio")}>
          AI Image Studio <span className="badge">Beta</span>
        </button>
      </nav>
      <main className="shell">
        {tab === "enrich" && <EnrichmentSection />}
        {tab === "email" && <EmailSection />}
        {tab === "studio" && <ImageStudioSection />}
      </main>
    </>
  );
}
