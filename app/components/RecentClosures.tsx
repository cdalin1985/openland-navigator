"use client";
/**
 * "Recently closed in Montana" panel: BLM claims the nightly watch saw go from open
 * to closed, newest first. Tapping one flies to it and runs the land check, because
 * closed is not the same as open to stake.
 */
import { useEffect, useState } from "react";
import { STALE_AFTER_DAYS, daysSinceUpdate, loadClaimChanges, summarize, type ClaimChanges, type ClaimChange } from "../lib/claim-changes";
import { CLAIM_ICON } from "../lib/map-icons";
import type { ClaimType } from "../lib/claim-markers";

const TYPE_LABEL: Record<ClaimType, string> = { placer: "Placer", lode: "Lode", millsite: "Mill site", tunnel: "Tunnel site", other: "Claim" };
const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

type Props = { onGoTo: (lon: number, lat: number) => void; onClose: () => void };

export default function RecentClosures({ onGoTo, onClose }: Props) {
  const [changes, setChanges] = useState<ClaimChanges | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    loadClaimChanges(controller.signal)
      .then(setChanges)
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load the list"); });
    return () => controller.abort();
  }, []);

  const s = changes ? summarize(changes) : null;
  const stale = changes ? daysSinceUpdate(changes) : 0;
  const status = (e: ClaimChange) =>
    e.reversed ? { text: "Reopened by BLM since", color: "#fca5a5" }
      : e.covered ? { text: "Active claim on it now", color: "#cbd5e1" }
        : { text: "No active claim on it in BLM's map", color: "#67e8f9" };

  return (
    <div style={{
      position: "absolute", top: "112px", left: "14px", zIndex: 28, width: "min(340px, calc(100vw - 28px))",
      maxHeight: "calc(100dvh - 210px - env(safe-area-inset-bottom))",
      background: "rgba(15, 23, 42, 0.96)", backdropFilter: "blur(12px)", color: "#fff",
      borderRadius: "14px", border: "1px solid #06b6d4", boxShadow: "0 20px 40px rgba(0,0,0,0.7)",
      display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{ padding: "10px 14px", background: "linear-gradient(90deg, #0e7490, #1e293b)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: "12px", letterSpacing: "0.4px" }}>RECENTLY CLOSED IN MONTANA{s ? ` (${s.closures.length})` : ""}</strong>
        <button aria-label="Close recently closed list" onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: "16px", cursor: "pointer" }}>×</button>
      </div>
      <div style={{ padding: "10px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px" }}>
        {!changes && !error && <div style={{ color: "#94a3b8", padding: "8px" }}>Loading the nightly claim check…</div>}
        {error && <div role="alert" style={{ color: "#fca5a5", padding: "8px" }}>{error}. That is not the same as &quot;nothing closed&quot; — try again later.</div>}
        {changes && s && <>
          <div style={{ color: "#94a3b8", lineHeight: 1.45 }}>
            BLM claims we saw go from open to closed. Checked nightly since {fmtDate(changes.trackingSince)}; last check {fmtDate(changes.generatedAt)}.
            {" "}Montana now: {changes.counts.notClosed.toLocaleString("en-US")} open claims, {changes.counts.closed.toLocaleString("en-US")} in BLM&apos;s closed map.
          </div>
          {stale > STALE_AFTER_DAYS && <div role="alert" style={{ color: "#fde68a", background: "#78350f", padding: "6px 8px", borderRadius: "8px" }}>
            The nightly check hasn&apos;t run for {stale} days, so recent closures may be missing.
          </div>}
          {s.closures.length === 0 && <div style={{ padding: "8px", color: "#cbd5e1" }}>
            No closures seen since {fmtDate(changes.trackingSince)}. Most Montana claims lapse after the September 1 BLM fee deadline.
          </div>}
          {s.closures.map(e => {
            const st = status(e);
            return <button key={`${e.id}-${e.date}`} onClick={() => onGoTo(e.lon, e.lat)} style={{
              display: "flex", gap: "9px", alignItems: "center", textAlign: "left", width: "100%", padding: "9px",
              border: "1px solid #ffffff1a", borderRadius: "10px", background: "#122027", color: "#fff", cursor: "pointer",
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={(e.covered || e.reversed ? CLAIM_ICON.covered : CLAIM_ICON.closed)[e.type]} alt="" width={24} height={24} style={{ flexShrink: 0 }} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <b style={{ fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</b>
                <small style={{ color: "#94a3b8", fontSize: "10px" }}>{TYPE_LABEL[e.type]}{e.acres ? ` · ${e.acres.toFixed(1)} ac` : ""} · {e.id} · seen closed {fmtDate(e.date)}</small>
                <small style={{ color: st.color, fontSize: "10px", fontWeight: 700 }}>{st.text}</small>
              </span>
              <em style={{ color: "#62f3aa", fontStyle: "normal", fontWeight: 900 }}>›</em>
            </button>;
          })}
          <div style={{ color: "#94a3b8", fontSize: "10.5px", lineHeight: 1.45 }}>
            Also in the last 30 days: {s.newLast30.toLocaleString("en-US")} new claims filed in Montana
            {s.removedLast30 ? `, and ${s.removedLast30} dropped from BLM's open-claim map without showing up as closed (check MLRS)` : ""}.
          </div>
          <div style={{ color: "#94a3b8", fontSize: "10.5px", lineHeight: 1.45 }}>
            Closed is not the same as open to stake. Tap a claim to run the land check (withdrawals, wilderness, private land, newer claims). BLM maps claims to survey squares, not staked corners.
          </div>
        </>}
      </div>
    </div>
  );
}
