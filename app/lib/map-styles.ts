/**
 * OpenLayers styles for the rental and mining-claim icon layers.
 * Styles are cached: OpenLayers calls these for every feature on every frame.
 */
import type Feature from "ol/Feature";
import type { FeatureLike } from "ol/Feature";
import { Circle, Fill, Icon, RegularShape, Stroke, Style, Text } from "ol/style";
import type { CabinKind } from "./cabins";
import type { ClaimMarker, ClaimStatus } from "./claim-markers";
import { ACTIVE_CLAIM_COLOR, CLAIM_ICON, CLOSED_CLAIM_COLOR, COVERED_CLAIM_COLOR, RENTAL_ICON, type ClaimLook } from "./map-icons";

const cache: Record<string, Style | Style[]> = {};
const cached = (key: string, make: () => Style | Style[]) => (cache[key] ??= make());

/** Rental icon for a kind: small when zoomed far out, with a yellow ring when selected. */
export function rentalStyle(kind: CabinKind, size: "small" | "normal" | "selected"): Style | Style[] {
  return cached(`rental:${kind}:${size}`, () => {
    const icon = (scale: number) => new Style({ image: new Icon({ src: RENTAL_ICON[kind] ?? RENTAL_ICON.Cabin, scale }), zIndex: size === "selected" ? 32 : 30 });
    if (size === "small") return icon(0.55);
    if (size === "normal") return icon(0.8);
    return [
      new Style({ image: new Circle({ radius: 24, stroke: new Stroke({ color: "#facc15", width: 4 }), fill: new Fill({ color: "rgba(250,204,21,0.25)" }) }), zIndex: 31 }),
      icon(1),
    ];
  });
}

/** Which icon a single claim gets: active, closed with no active claim on it, or closed and covered/unchecked. */
export function claimLook(m: ClaimMarker): ClaimLook {
  if (m.status === "active") return "active";
  return m.covered === false ? "closed" : "covered";
}

/**
 * Style for a clustered claim icon layer. One claim shows its type icon; several
 * claims close together (often the same BLM survey square) show a count badge,
 * cyan for closed claims if any of them has no active claim on it, otherwise grey.
 */
export function claimClusterStyle(status: ClaimStatus) {
  return (cluster: FeatureLike): Style => {
    const members = (cluster.get("features") as Feature[] | undefined) ?? [];
    const markers = members.map(f => f.get("marker") as ClaimMarker);
    if (markers.length === 1) {
      const m = markers[0];
      const look = claimLook(m);
      return cached(`claim:${look}:${m.type}`, () => new Style({ image: new Icon({ src: CLAIM_ICON[look][m.type], scale: 0.72 }), zIndex: 1 })) as Style;
    }
    const color = status === "active" ? ACTIVE_CLAIM_COLOR : markers.some(m => m.covered === false) ? CLOSED_CLAIM_COLOR : COVERED_CLAIM_COLOR;
    const count = markers.length;
    const label = count > 999 ? "999+" : String(count);
    return cached(`cluster:${status}:${color}:${label}`, () => {
      const radius = Math.min(19, 11 + Math.log2(count) * 1.6);
      const fill = new Fill({ color }), stroke = new Stroke({ color: "#fff", width: 2.5 });
      return new Style({
        // Squares for closed claims, circles for active, matching the single icons.
        image: status === "active"
          ? new Circle({ radius, fill, stroke })
          : new RegularShape({ points: 4, radius: radius * 1.25, angle: Math.PI / 4, fill, stroke }),
        text: new Text({ text: label, font: "800 11px Arial, sans-serif", fill: new Fill({ color: "#fff" }) }),
        zIndex: 2,
      });
    }) as Style;
  };
}
