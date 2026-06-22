"use client";
import React, { useRef, useState } from "react";

interface Item {
  id: string;
  name: string;
  url: string;       // object URL for preview
  file: File;
  w: number;
  h: number;
}

export default function ImageStudioSection() {
  const ref = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [scale, setScale] = useState(100);      // percent
  const [removeBg, setRemoveBg] = useState(false); // coming soon (disabled)
  const [busy, setBusy] = useState(false);

  function addFiles(files: FileList | null) {
    if (!files) return;
    const next: Item[] = [];
    let pending = files.length;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) { pending--; return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        next.push({ id: file.name + Math.random(), name: file.name, url, file, w: img.width, h: img.height });
        pending--;
        if (pending === 0) setItems((prev) => [...prev, ...next]);
      };
      img.src = url;
    });
  }

  // Resize one image via canvas and return a blob.
  function resizeImage(item: Item, pct: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = Math.max(1, Math.round(img.width * (pct / 100)));
        const h = Math.max(1, Math.round(img.height * (pct / 100)));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas"));
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
      };
      img.onerror = reject;
      img.src = item.url;
    });
  }

  async function downloadOne(item: Item) {
    setBusy(true);
    try {
      const blob = await resizeImage(item, scale);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name.replace(/\.[^.]+$/, "") + `_${scale}pct.png`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  async function downloadAll() {
    setBusy(true);
    try {
      for (const item of items) {
        const blob = await resizeImage(item, scale);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = item.name.replace(/\.[^.]+$/, "") + `_${scale}pct.png`;
        a.click();
        URL.revokeObjectURL(url);
        await new Promise((r) => setTimeout(r, 150)); // let the browser queue each download
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="coming-banner">
        <div>
          <h2>AI Image Studio</h2>
          <p>
            Prep catalogue images in bulk — resize/re-resolution now, with background removal and
            AI clean-up coming soon. Everything runs in your browser; nothing is uploaded.
          </p>
        </div>
        <span className="coming-chip">Beta</span>
      </div>

      <div className="card">
        <span className="section-eyebrow">Upload</span>
        <h2>Catalogue images</h2>
        <p className="hint">Drop product images (JPG/PNG/WebP). Processing happens locally.</p>
        <div
          className="dropzone"
          onClick={() => ref.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        >
          <div className="fn">Drop images or click to upload</div>
          <div className="meta">{items.length ? `${items.length} image(s) loaded` : "Bulk upload supported"}</div>
          <input ref={ref} type="file" accept="image/*" multiple style={{ display: "none" }}
            onChange={(e) => addFiles(e.target.files)} />
        </div>
      </div>

      <div className="card">
        <span className="section-eyebrow">Options</span>
        <h2>Processing</h2>
        <div className="row">
          <div className="col">
            <label className="field">Resolution — {scale}%</label>
            <div className="slider-row">
              <input type="range" min={10} max={200} step={5} value={scale}
                onChange={(e) => setScale(+e.target.value)} />
              <span className="slider-val">{scale}%</span>
            </div>
            <small className="dim">Scales width &amp; height proportionally. 100% keeps original size.</small>
          </div>
          <div className="col">
            <label className="field">Background removal <span className="badge" style={{ marginLeft: 6 }}>Soon</span></label>
            <label style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13, opacity: 0.55 }}>
              <input type="checkbox" checked={removeBg} disabled onChange={(e) => setRemoveBg(e.target.checked)} />
              Remove background (coming soon)
            </label>
            <small className="dim">In-browser AI background removal will be enabled in a later release.</small>
          </div>
          <div className="col" style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn" disabled={!items.length || busy} onClick={downloadAll}>
              {busy ? "Processing…" : `Resize & download all (${items.length})`}
            </button>
          </div>
        </div>
      </div>

      {items.length > 0 && (
        <div className="card">
          <span className="section-eyebrow">Preview</span>
          <h2>Loaded images</h2>
          <div className="img-grid">
            {items.map((it) => (
              <div className="img-tile" key={it.id}>
                <div className="img-thumb" style={{ backgroundImage: `url(${it.url})` }} />
                <div className="img-meta">
                  <div className="img-name" title={it.name}>{it.name}</div>
                  <div className="img-dim">
                    {it.w}×{it.h} → {Math.round(it.w * scale / 100)}×{Math.round(it.h * scale / 100)}
                  </div>
                </div>
                <button className="btn secondary img-dl" disabled={busy} onClick={() => downloadOne(it)}>
                  Download
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
