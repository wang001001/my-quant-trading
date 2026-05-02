// scripts/snapshot-diff.mjs
//
// Compare two snapshot JSON files (baseline vs current).
// Exit 0 if shapes are identical; exit 1 with a human-readable diff otherwise.
//
// Tolerance:
// - Array length descriptors "<array len=N>" tolerate ±1 (market data drift).
// - All other differences are strict (key added/removed, type changed, error message changed).
//
// Usage:
//   node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/current.json

import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  process.stderr.write("usage: snapshot-diff.mjs <baseline.json> <current.json>\n");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(a, "utf-8"));
const current  = JSON.parse(readFileSync(b, "utf-8"));

const diffs = [];

function pushDiff(path, msg) { diffs.push(`${path}: ${msg}`); }

function arrayLenTag(s) {
  const m = typeof s === "string" && s.match(/^<array len=(\d+)>$/);
  return m ? Number(m[1]) : null;
}

function compare(a, b, path) {
  if (a === null && b === null) return;
  if (a === null) return pushDiff(path, `null vs ${typeof b}`);
  if (b === null) return pushDiff(path, `${typeof a} vs null`);

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0 && b.length === 0) return;
    if (a.length === 0 || b.length === 0) {
      return pushDiff(path, `array length mismatch: ${a.length} vs ${b.length}`);
    }
    const aLen = arrayLenTag(a[0]);
    const bLen = arrayLenTag(b[0]);
    if (aLen !== null && bLen !== null) {
      if (Math.abs(aLen - bLen) > 1) {
        pushDiff(path, `array length drift > 1: ${aLen} vs ${bLen}`);
      }
      compare(a[1], b[1], `${path}[]`);
    } else {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) compare(a[i], b[i], `${path}[${i}]`);
      if (a.length !== b.length) pushDiff(path, `array length: ${a.length} vs ${b.length}`);
    }
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return pushDiff(path, `type mismatch: ${Array.isArray(a) ? "array" : typeof a} vs ${Array.isArray(b) ? "array" : typeof b}`);
  }

  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    const all = new Set([...keysA, ...keysB]);
    for (const k of all) {
      if (!(k in a)) pushDiff(`${path}.${k}`, `key added`);
      else if (!(k in b)) pushDiff(`${path}.${k}`, `key removed`);
      else compare(a[k], b[k], `${path}.${k}`);
    }
    return;
  }

  if (a !== b) {
    pushDiff(path, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

compare(baseline, current, "");

if (diffs.length === 0) {
  process.stderr.write(`[snapshot-diff] OK: ${a} ≡ ${b}\n`);
  process.exit(0);
} else {
  process.stderr.write(`[snapshot-diff] ${diffs.length} difference(s) between ${a} and ${b}:\n`);
  for (const d of diffs) process.stdout.write(d + "\n");
  process.exit(1);
}
