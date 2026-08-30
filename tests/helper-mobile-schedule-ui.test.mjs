import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("supplier schedule cards stack and wrap at mobile width", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const page = readFileSync("app/page.tsx", "utf8");
  assert.match(css, /\.schedule-card-list\{display:grid/);
  assert.match(css, /\.schedule-card\{[^}]*width:100%[^}]*flex-direction:column/);
  assert.match(css, /\.day-button-grid\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(page, /daySummary\(item\.days\)/);
  assert.match(page, /formatDisplayTime\(item\.start\)/);
});

test("mobile header reserves safe-area height before screen content", () => {
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(css, /\.mobile-header\{height:calc\(58px \+ env\(safe-area-inset-top\)\);padding:env\(safe-area-inset-top\) 20px 0\}/);
  assert.match(css, /\.screen\{padding:26px 24px 34px/);
});

test("busy schedule cards expose only schedule data and a Busy label", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  const start = page.indexOf("busyPeriods.map(item => <div className=\"schedule-card\"");
  const end = page.indexOf("helperActiveBookings.map", start);
  const busyMarkup = page.slice(start, end);
  assert.match(busyMarkup, />Busy</);
  assert.doesNotMatch(busyMarkup, /resident|employer|address|external recurring work/i);
});

test("visible controls submit unchanged canonical HH:mm values", () => {
  const controls = readFileSync("app/components/helper-schedule-controls.tsx", "utf8");
  assert.match(controls, /<option key=\{time\} value=\{time\}>\{formatDisplayTime\(time\)\}/);
  assert.match(controls, /onChange\(event\.target\.value\)/);
});
