/**
 * Map icons drawn as small inline SVGs (data URIs), so they load with the app,
 * work offline and need no image files.
 *
 * Rentals share one purple circle (the "places to stay" colour) with a white
 * picture for each kind. Claims use the claim colours already on the map:
 * active claims are pink circles, closed claims are squares (cyan when no active
 * claim sits on them in BLM's map, grey when one does, a cyan outline when that
 * hasn't been checked), with a picture for the claim type. Circles vs squares keep
 * active and closed apart without colour.
 */
import type { CabinKind } from "./cabins.ts";
import type { ClaimType } from "./claim-markers.ts";

export const RENTAL_COLOR = "#7c3aed";
export const ACTIVE_CLAIM_COLOR = "#e600a9";
export const CLOSED_CLAIM_COLOR = "#0891b2";
export const COVERED_CLAIM_COLOR = "#64748b";
/** Outline colour and dark fill for closed claims not yet compared with active ones. */
export const UNCHECKED_CLAIM_COLOR = "#22d3ee";
export const UNCHECKED_CLAIM_FILL = "#0b1720";

const W = "#fff";
const svgUri = (body: string) =>
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 36 36'>${body}</svg>`);
const circleBase = (fill: string) => `<circle cx='18' cy='18' r='15' fill='${fill}' stroke='${W}' stroke-width='3'/>`;
const squareBase = (fill: string, edge = W) => `<rect x='3.5' y='3.5' width='29' height='29' rx='8' fill='${fill}' stroke='${edge}' stroke-width='3'/>`;

/** White pictures for each rental kind; `bg` is the base colour, used for cut-outs like doors and windows. */
const RENTAL_GLYPH: Record<CabinKind, (bg: string) => string> = {
  // Peaked cabin with a door.
  Cabin: bg => `<path d='M18 8 L8 17 H11 V27 H25 V17 Z' fill='${W}'/><rect x='15.5' y='20' width='5' height='7' fill='${bg}'/>`,
  // Fire lookout: a roofed cab on splayed tower legs.
  Lookout: () =>
    `<path d='M11.5 13 L18 7.5 L24.5 13 Z' fill='${W}'/><rect x='13' y='13' width='10' height='5' fill='${W}'/>` +
    `<path d='M14.5 18 L11.5 28 M21.5 18 L24.5 28 M13 23.5 H23' stroke='${W}' stroke-width='2.2' fill='none' stroke-linecap='round'/>`,
  // Guard station: a building with a flag on a pole.
  "Guard station": bg =>
    `<path d='M10 28 V9' stroke='${W}' stroke-width='2' stroke-linecap='round'/><path d='M10 9 H17 L15 11.5 L17 14 H10 Z' fill='${W}'/>` +
    `<path d='M21 13 L13.5 19.5 H15.5 V27 H27 V19.5 H29 Z' fill='${W}'/><rect x='19.5' y='21.5' width='4' height='5.5' fill='${bg}'/>`,
  // Bunkhouse / house: a long building with two windows.
  House: bg =>
    `<path d='M7 18.5 L12.5 12 H23.5 L29 18.5 V27 H7 Z' fill='${W}'/>` +
    `<rect x='10.5' y='20' width='4.5' height='4' fill='${bg}'/><rect x='21' y='20' width='4.5' height='4' fill='${bg}'/>`,
};

/** Pictures for each claim type, drawn in `fg` (white unless given); `bg` is the base colour for cut-outs. */
const CLAIM_GLYPH: Record<ClaimType, (bg: string, fg?: string) => string> = {
  // Placer: a gold pan with nuggets.
  placer: (_bg, fg = W) =>
    `<path d='M7 15.5 H29 L25 25 H11 Z' fill='${fg}'/>` +
    `<circle cx='14.5' cy='19' r='2' fill='#eab308'/><circle cx='19' cy='20.5' r='1.7' fill='#eab308'/><circle cx='22.5' cy='18.5' r='1.4' fill='#eab308'/>`,
  // Lode: a pickaxe.
  lode: (_bg, fg = W) =>
    `<path d='M11 27 L24.8 11' stroke='${fg}' stroke-width='3' stroke-linecap='round'/>` +
    `<path d='M17.5 7.5 Q26 9.5 28.8 17.6' stroke='${fg}' stroke-width='3.2' fill='none' stroke-linecap='round'/>`,
  // Mill site: a gear.
  millsite: (_bg, fg = W) =>
    `<circle cx='18' cy='18' r='8.4' fill='none' stroke='${fg}' stroke-width='3.6' stroke-dasharray='3.3 3.3'/>` +
    `<circle cx='18' cy='18' r='5.4' fill='none' stroke='${fg}' stroke-width='3'/>`,
  // Tunnel site: a tunnel mouth.
  tunnel: (bg, fg = W) => `<path d='M8.5 27 V18.5 A9.5 9.5 0 0 1 27.5 18.5 V27 Z' fill='${fg}'/><path d='M13.5 27 V19.5 A4.5 4.5 0 0 1 22.5 19.5 V27 Z' fill='${bg}'/>`,
  // Anything BLM labels differently: a plain claim post.
  other: (_bg, fg = W) => `<path d='M18 9 L26 18 L18 27 L10 18 Z' fill='${fg}'/>`,
};

const mapValues = <K extends string, V>(keys: K[], fn: (k: K) => V) =>
  Object.fromEntries(keys.map(k => [k, fn(k)])) as Record<K, V>;

const RENTAL_KINDS: CabinKind[] = ["Cabin", "Lookout", "Guard station", "House"];
const CLAIM_TYPES: ClaimType[] = ["placer", "lode", "millsite", "tunnel", "other"];

/** Rental icon per kind. */
export const RENTAL_ICON = mapValues(RENTAL_KINDS, k => svgUri(circleBase(RENTAL_COLOR) + RENTAL_GLYPH[k](RENTAL_COLOR)));

/**
 * Claim icons per look and type: "active"; "closed" = no active claim mapped on it;
 * "covered" = an active claim is mapped on it; "unchecked" = not compared yet (zoomed out, or a lookup failed).
 */
export const CLAIM_ICON = {
  active: mapValues(CLAIM_TYPES, t => svgUri(circleBase(ACTIVE_CLAIM_COLOR) + CLAIM_GLYPH[t](ACTIVE_CLAIM_COLOR))),
  closed: mapValues(CLAIM_TYPES, t => svgUri(squareBase(CLOSED_CLAIM_COLOR) + CLAIM_GLYPH[t](CLOSED_CLAIM_COLOR))),
  covered: mapValues(CLAIM_TYPES, t => svgUri(squareBase(COVERED_CLAIM_COLOR) + CLAIM_GLYPH[t](COVERED_CLAIM_COLOR))),
  unchecked: mapValues(CLAIM_TYPES, t => svgUri(squareBase(UNCHECKED_CLAIM_FILL, UNCHECKED_CLAIM_COLOR) + CLAIM_GLYPH[t](UNCHECKED_CLAIM_FILL, UNCHECKED_CLAIM_COLOR))),
};
export type ClaimLook = keyof typeof CLAIM_ICON;
