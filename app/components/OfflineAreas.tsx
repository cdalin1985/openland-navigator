"use client";
/**
 * "Offline areas" panel for the More tab: save the current map view for use
 * with no cell signal, then list, revisit or delete saved areas.
 */
import { useState } from "react";
import {
  MAX_AREA_SQ_MI,
  deleteArea,
  downloadArea,
  estimateArea,
  listAreas,
  type BBox,
  type OfflineAreaSummary,
} from "../lib/offline";

type Props = {
  /** The current map view, or null if the map isn't ready. */
  getViewBBox: () => BBox | null;
  /** Fly the map to a saved area. */
  onGoTo: (bbox: BBox) => void;
};

export default function OfflineAreas({ getViewBBox, onGoTo }: Props) {
  const [areas, setAreas] = useState<OfflineAreaSummary[]>(() => listAreas());
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [message, setMessage] = useState("");

  /** Download the current view after confirming its size. */
  async function save() {
    const bbox = getViewBBox();
    if (!bbox || progress) return;
    const est = estimateArea(bbox);
    if (est.tooBig) {
      setMessage(`This view is about ${est.sqMi.toFixed(0)} sq mi. Zoom in until it's ${MAX_AREA_SQ_MI} sq mi or less, then save.`);
      return;
    }
    if (!window.confirm(`Save this view for offline use? About ${Math.max(1, Math.round(est.megabytes))} MB: land records plus ${est.tiles.toLocaleString("en-US")} USGS map tiles. Best on Wi-Fi.`)) return;
    const name = `Area near ${((bbox[1] + bbox[3]) / 2).toFixed(3)}, ${((bbox[0] + bbox[2]) / 2).toFixed(3)}`;
    setMessage("");
    setProgress({ done: 0, total: 1, label: "Starting…" });
    try {
      const summary = await downloadArea(bbox, name, (done, total, label) => setProgress({ done, total, label }));
      setAreas(listAreas());
      setMessage(`Saved: ${summary.featureCount.toLocaleString("en-US")} land records and ${summary.tileCount.toLocaleString("en-US")} map tiles (${(summary.bytes / 1e6).toFixed(1)} MB).`);
    } catch (e) {
      setMessage(`Couldn't save this area (${e instanceof Error ? e.message : "download failed"}). Nothing was saved; try again with a better signal.`);
    } finally {
      setProgress(null);
    }
  }

  async function remove(id: string) {
    await deleteArea(id);
    setAreas(listAreas());
  }

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  return (
    <div className="about-card">
      <small>OFFLINE AREAS</small>
      <p>No signal at the creek? Save the area first. Land checks, dig-spot checks and claim-box checks then work from the saved copy, marked with the date you saved it.</p>
      <button className="save-current" disabled={Boolean(progress)} onClick={save}>
        {progress ? `${progress.label} ${pct}%` : "📥 Save this map view for offline"}
      </button>
      {message && <p role="status">{message}</p>}
      {areas.length > 0 && (
        <div className="saved-list">
          {areas.map(area => (
            <div key={area.id}>
              <button onClick={() => onGoTo(area.bbox)}>
                <span>
                  <b>{area.name}</b>
                  <small>
                    Saved {new Date(area.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · {area.tileCount.toLocaleString("en-US")} tiles · {(area.bytes / 1e6).toFixed(1)} MB
                  </small>
                </span>
                <em>›</em>
              </button>
              <button aria-label={`Delete ${area.name}`} className="remove-saved" onClick={() => remove(area.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      <p>
        Saved: BLM active and closed claims, county parcels, public land ownership, BLM withdrawals, wilderness, USGS stream lines, and USGS imagery, topo and water-label tiles (zoom 10–16).
        Not saved: Google satellite (Google&apos;s terms forbid it), the 2025 NAIP close-up layer, USGS mine records, and the upstream gold check. Claims change, so refresh areas before each trip.
      </p>
    </div>
  );
}
