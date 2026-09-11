import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCENTS, ACCENT_NAMES, isAccentName, paletteFor, type Palette } from "./palette.js";

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a six-digit hex colour: ${hex}`);
  const channels = [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const schemes = ["light", "dark"] as const;

/** Text pairings the app actually draws, as [foreground, background] keys. */
const TEXT_PAIRS: Array<[keyof Palette, keyof Palette]> = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surfaceAlt"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "surfaceAlt"],
  ["accentText", "accent"],
  ["danger", "surface"],
  ["success", "surface"],
  ["warning", "surface"],
  ["danger", "surfaceAlt"],
  ["success", "surfaceAlt"],
  ["warning", "surfaceAlt"],
  ["danger", "bg"],
];

describe("palette", () => {
  it("knows its own accent names", () => {
    assert.equal(isAccentName("midnight"), true);
    assert.equal(isAccentName("chartreuse"), false);
    assert.deepEqual(ACCENT_NAMES.slice().sort(), Object.keys(ACCENTS).sort());
  });

  it("takes a name only when the table owns it", () => {
    // ACCENTS is a plain object, so a membership test that is not an
    // own-property test is true for every name on Object.prototype - and a
    // stored accent of "toString" then indexes the table to undefined and
    // leaves the whole app with no accent colour, which is every pairing
    // checked below quietly not being checked at all. Walked rather than
    // listed, so a name nobody remembered to add is covered too.
    for (const inherited of Object.getOwnPropertyNames(Object.prototype)) {
      assert.equal(isAccentName(inherited), false, `${inherited} is not an accent`);
    }
    // ...and the consequence, in the terms this file is about: whatever the
    // check lets through has to be a colour.
    for (const name of ACCENT_NAMES) {
      assert.match(paletteFor("dark", name).accent, /^#[0-9a-f]{6}$/i);
    }
  });

  it("defines every colour in both schemes for every accent", () => {
    const keys = Object.keys(paletteFor("dark", "midnight")) as Array<keyof Palette>;
    for (const scheme of schemes) {
      for (const accent of ACCENT_NAMES) {
        const p = paletteFor(scheme, accent);
        for (const k of keys) {
          assert.ok(typeof p[k] === "string" && p[k].length > 0, `${scheme}/${accent} is missing ${k}`);
        }
      }
    }
  });

  it("carries the chosen accent into the palette", () => {
    for (const accent of ACCENT_NAMES) {
      assert.equal(paletteFor("dark", accent).accent, ACCENTS[accent].accent);
      assert.equal(paletteFor("light", accent).accentText, ACCENTS[accent].accentText);
    }
  });

  it("meets WCAG AA (4.5:1) for body text in both schemes", () => {
    const failures: string[] = [];
    for (const scheme of schemes) {
      for (const accent of ACCENT_NAMES) {
        const p = paletteFor(scheme, accent);
        for (const [fg, bg] of TEXT_PAIRS) {
          const ratio = contrast(p[fg], p[bg]);
          if (ratio < 4.5) failures.push(`${scheme}/${accent} ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it("keeps surfaces distinguishable from the background", () => {
    for (const scheme of schemes) {
      const p = paletteFor(scheme, "midnight");
      assert.notEqual(p.surface, p.bg, `${scheme}: surface is invisible against the background`);
      assert.ok(contrast(p.border, p.surface) > 1.05, `${scheme}: borders vanish on surfaces`);
    }
  });
});
