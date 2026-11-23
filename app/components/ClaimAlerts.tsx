"use client";
/**
 * "Claim alerts" panel for the More tab: save the current map view as a watch
 * area and get an email when BLM claims there close, are filed, or reopen.
 * Uses Sign in with ChatGPT (Sites' /signin-with-chatgpt) and /api/watches.
 */
import { useEffect, useState } from "react";
import type { BBox } from "../lib/offline";

type WatchRow = { id: number; name: string; box: BBox; createdAt: string };
type State =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "unavailable"; message: string }
  | { kind: "error" }
  | { kind: "ready"; email: string; emailEnabled: boolean; watches: WatchRow[]; maxWatches: number };

type Props = { getViewBBox: () => BBox | null; onGoTo: (bbox: BBox) => void };

async function loadState(): Promise<State> {
  try {
    const res = await fetch("/api/watches", { cache: "no-store" });
    if (res.status === 401) return { kind: "signedOut" };
    const body = await res.json().catch(() => ({}));
    if (res.status === 503) return { kind: "unavailable", message: body.error ?? "Claim alerts aren't set up on this site yet." };
    if (!res.ok) return { kind: "error" };
    return { kind: "ready", email: body.email, emailEnabled: Boolean(body.emailEnabled), watches: body.watches ?? [], maxWatches: body.limits?.maxWatches ?? 10 };
  } catch {
    return { kind: "error" };
  }
}

export default function ClaimAlerts({ getViewBBox, onGoTo }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadState().then(s => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, []);

  async function watchView() {
    const box = getViewBBox();
    if (!box || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/watches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ box, name }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(body.error ?? "Couldn't save this area. Try again.");
      else { setName(""); setMessage(`Watching "${body.watch.name}".`); setState(await loadState()); }
    } catch {
      setMessage("Couldn't reach OpenLand. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/watches/${id}`, { method: "DELETE" });
      if (!res.ok) setMessage("Couldn't remove that area. Try again.");
      setState(await loadState());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="about-card claim-alerts">
      <small>CLAIM ALERTS</small>
      <p>Get an email when BLM records a claim closing, a new claim filed, or a closure reversed inside an area you watch. Checked nightly, Montana only.</p>
      {state.kind === "loading" && <p>Checking your alerts…</p>}
      {state.kind === "error" && <p role="alert">Couldn&apos;t load your alerts. Check your connection and try again.</p>}
      {state.kind === "unavailable" && <p role="alert">{state.message}</p>}
      {state.kind === "signedOut" && <>
        <p>Sign in so alerts go to your email address.</p>
        <a className="save-current alerts-signin" href="/signin-with-chatgpt">Sign in with ChatGPT</a>
      </>}
      {state.kind === "ready" && <>
        <p>Signed in as <b>{state.email}</b> · <a href="/signout-with-chatgpt">Sign out</a></p>
        {!state.emailEnabled && <p role="status" className="alerts-off">Email sending isn&apos;t switched on for this site yet. Your areas are saved and start emailing once it is.</p>}
        {state.watches.length < state.maxWatches ? <>
          <input className="alerts-name" aria-label="Name for this area (optional)" placeholder="Name this area (optional)" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
          <button className="save-current" disabled={busy} onClick={watchView}>{busy ? "Saving…" : "🔔 Watch this map view"}</button>
        </> : <p>You&apos;re watching the most areas allowed ({state.maxWatches}). Remove one to add another.</p>}
        {state.watches.length > 0 && <div className="saved-list">
          {state.watches.map(w => (
            <div key={w.id}>
              <button onClick={() => onGoTo(w.box)}><span><b>{w.name}</b><small>Watching since {String(w.createdAt).slice(0, 10)}</small></span><em>›</em></button>
              <button aria-label={`Stop watching ${w.name}`} className="remove-saved" disabled={busy} onClick={() => remove(w.id)}>×</button>
            </div>
          ))}
        </div>}
      </>}
      {message && <p role="status">{message}</p>}
      <p>Emails list each change with a link that opens it here and runs the land check. Closed is not the same as open to stake.</p>
    </div>
  );
}
