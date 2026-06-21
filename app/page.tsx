"use client";
import React, { useState } from "react";
import SimulatorSection from "./components/SimulatorSection";
import EnrichmentSection from "./components/EnrichmentSection";
import EmailSection from "./components/EmailSection";

type Tab = "enrich" | "email" | "simulate";

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
        <span className="spacer" />
        <button className="tab secondary" data-active={tab === "simulate"} onClick={() => setTab("simulate")}>
          Build Incorrect Data
        </button>
      </nav>
      <main className="shell">
        {tab === "enrich" && <EnrichmentSection />}
        {tab === "email" && <EmailSection />}
        {tab === "simulate" && <SimulatorSection />}
      </main>
    </>
  );
}
