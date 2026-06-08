import { useState } from "react";
import { EXAMPLES } from "../data/examples";
import type { ExampleLoadRequest } from "../state/load-example";

type Props = { onSubmit: (request: ExampleLoadRequest) => void };

export function EmptyState({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "rgba(44, 50, 51, 0.32)",
        zIndex: 10,
        padding: 16,
      }}
    >
      <div
        className="panel"
        style={{
          padding: 24,
          width: "min(480px, 100%)",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <span className="panel-header">GeoZarr Viewer</span>
          <h2 style={{ margin: 0, fontWeight: 600, fontSize: 20 }}>
            Open a GeoZarr / Zarr store
          </h2>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Pick a bundled example below, or paste any GeoZarr / Zarr store
            URL.
          </span>
        </div>

        <label style={{ display: "grid", gap: 6 }}>
          <span className="field-label">Paste a Zarr URL</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              aria-label="zarr-url"
              placeholder="https://…/data.zarr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="primary"
              disabled={!value}
              onClick={() => onSubmit({ url: value })}
            >
              Load
            </button>
          </div>
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span className="field-label">Or pick an example</span>
          <select
            aria-label="example"
            defaultValue=""
            onChange={(e) => {
              const selected = EXAMPLES.find((ex) => ex.url === e.target.value);
              if (selected) {
                onSubmit({ url: selected.url, params: selected.params });
              }
            }}
          >
            <option value="" disabled>
              Choose…
            </option>
            {EXAMPLES.map((ex) => (
              <option key={ex.url} value={ex.url}>
                {ex.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
