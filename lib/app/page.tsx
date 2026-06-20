"use client";
import React, { useState } from "react";
import SimulatorSection from "./components/SimulatorSection";
import EnrichmentSection from "./components/EnrichmentSection";

export default function Page() {
  const [tab, setTab] = useState<"enrich" | "simulate">("enrich");
  return (
    <main className="shell">
      <div className="tabs">
        <button className="tab" data-active={tab === "enrich"} onClick={() => setTab("enrich")}>
          Enrichment dashboard
        </button>
        <button className="tab" data-active={tab === "simulate"} onClick={() => setTab("simulate")}>
          Build incorrect data
        </button>
      </div>
      {tab === "enrich" ? <EnrichmentSection /> : <SimulatorSection />}
    </main>
  );
}
