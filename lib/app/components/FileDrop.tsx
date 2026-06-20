"use client";
import React, { useRef, useState } from "react";

interface Props {
  label: string;
  hint?: string;
  optional?: boolean;
  onFile: (file: File) => void;
  fileName?: string | null;
}

export default function FileDrop({ label, hint, optional, onFile, fileName }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handle(files: FileList | null) {
    if (files && files[0]) onFile(files[0]);
  }

  return (
    <div>
      <label className="field">
        {label} {optional && <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span>}
      </label>
      <div
        className={"dropzone" + (fileName ? " has-file" : "")}
        style={dragOver ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : undefined}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handle(e.dataTransfer.files); }}
      >
        {fileName ? (
          <>
            <div className="fn">{fileName}</div>
            <div className="meta">Click to replace</div>
          </>
        ) : (
          <>
            <div className="fn">Drop file or click to upload</div>
            <div className="meta">{hint || ".xlsx, .xls or .csv"}</div>
          </>
        )}
        <input
          ref={ref}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => handle(e.target.files)}
        />
      </div>
    </div>
  );
}
