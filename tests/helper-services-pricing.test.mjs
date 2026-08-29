import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fixture, jsonRequest, profilePayload } from "./helpers/local-routes.mjs";

const route = "app/api/helper/profile/route.ts";
const baseServices = { houseCleaning: [], utensils: { frequency: "once", onceDailyMonthlyPricePaise: 50_000 } };

function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.save = (services, extra = {}) => f.load(route).PUT(jsonRequest({ ...profilePayload, offerings: undefined, services, ...extra }));
  f.get = async () => (await f.load(route).GET(new Request("https://example.test/api"))).json();
  f.rows = () => f.sql.prepare("SELECT service_type,home_size,monthly_price_paise,is_active FROM helper_offerings ORDER BY service_type,home_size").all();
  return f;
}

test("every house size persists its integer-paise price and refresh response", async t => {
  const f = setup(t);
  const houseCleaning = [
    { homeSize: "one_two_bhk", monthlyPricePaise: 60_001 },
    { homeSize: "three_bhk", monthlyPricePaise: 70_002 },
    { homeSize: "four_plus_bhk", monthlyPricePaise: 80_003 },
  ];
  assert.equal((await f.save({ houseCleaning, utensils: null })).status, 200);
  assert.deepEqual((await f.get()).services.houseCleaning.toSorted((a,b) => a.homeSize.localeCompare(b.homeSize)), houseCleaning.toSorted((a,b) => a.homeSize.localeCompare(b.homeSize)));
  assert.deepEqual(f.rows().map(row => [row.home_size, row.monthly_price_paise]), houseCleaning.map(row => [row.homeSize, row.monthlyPricePaise]).toSorted((a,b) => a[0].localeCompare(b[0])));
});

test("mixed house sizes and once-daily utensils persist without invented capabilities", async t => {
  const f = setup(t);
  const services = { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: 60_000 }, { homeSize: "four_plus_bhk", monthlyPricePaise: 90_000 }], utensils: { frequency: "once", onceDailyMonthlyPricePaise: 40_000 } };
  assert.equal((await f.save(services)).status, 200);
  const refreshed = await f.get();
  assert.equal(refreshed.offeringState, "conforming");
  assert.deepEqual(refreshed.services.utensils, services.utensils);
  assert.deepEqual(refreshed.services.houseCleaning.toSorted((a,b) => a.homeSize.localeCompare(b.homeSize)), services.houseCleaning.toSorted((a,b) => a.homeSize.localeCompare(b.homeSize)));
  assert.equal(f.rows().some(row => row.service_type === "utensils_twice" && row.is_active), false);
});

test("twice-daily derives exactly 2x and persists/exposes once-daily capability", async t => {
  const f = setup(t);
  assert.equal((await f.save({ houseCleaning: [], utensils: { frequency: "twice", onceDailyMonthlyPricePaise: 55_555 } })).status, 200);
  assert.deepEqual(f.rows().filter(row => row.is_active).map(row => [row.service_type, row.monthly_price_paise]), [["utensils_once", 55_555], ["utensils_twice", 111_110]]);
  assert.deepEqual((await f.get()).services.utensils, { frequency: "twice", onceDailyMonthlyPricePaise: 55_555, twiceDailyMonthlyPricePaise: 111_110 });
});

for (const [name, services] of [
  ["negative", { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: -1 }], utensils: null }],
  ["zero", { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: 0 }], utensils: null }],
  ["fractional", { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: 100.5 }], utensils: null }],
  ["unsafe", { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: Number.MAX_SAFE_INTEGER + 1 }], utensils: null }],
  ["malformed string", { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: "50000" }], utensils: null }],
  ["forged twice price", { houseCleaning: [], utensils: { frequency: "twice", onceDailyMonthlyPricePaise: 50_000, twiceDailyMonthlyPricePaise: 50_001 } }],
  ["contradictory extra field", { houseCleaning: [], utensils: { frequency: "once", onceDailyMonthlyPricePaise: 50_000, capability: "twice" } }],
]) test(`${name} service price is rejected without writes`, async t => {
  const f = setup(t); const before = f.rows();
  const response = await f.save(services);
  assert.equal(response.status, 400);
  assert.deepEqual(f.rows(), before);
});

test("conforming and inconsistent legacy rows are explicit; unrelated edits preserve both byte-for-byte", async t => {
  const f = setup(t);
  f.sql.exec("INSERT INTO helper_offerings(id,helper_user_id,service_type,home_size,monthly_price_paise) VALUES ('once','helper','utensils_once','not_applicable',50000),('twice','helper','utensils_twice','not_applicable',90000)");
  assert.equal((await f.get()).offeringState, "legacy_inconsistent");
  const before = f.rows();
  const { offerings, services, ...unrelated } = profilePayload; void offerings; void services;
  assert.equal((await f.load(route).PUT(jsonRequest({ ...unrelated, yearsExperience: 8 }))).status, 200);
  assert.deepEqual(f.rows(), before);
  assert.equal((await f.save(baseServices)).status, 200);
  assert.equal((await f.get()).offeringState, "conforming");
  assert.equal(f.rows().find(row => row.service_type === "utensils_twice").is_active, 0);
});

test("service update rollback is atomic", async t => {
  const f = setup(t); assert.equal((await f.save(baseServices)).status, 200); const before = f.rows();
  f.sql.exec("CREATE TRIGGER fail_offering BEFORE INSERT ON helper_offerings BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.equal((await f.save({ houseCleaning: [{ homeSize: "three_bhk", monthlyPricePaise: 70_000 }], utensils: null })).status, 500);
  assert.deepEqual(f.rows(), before);
});

test("pending requests and live bookings retain snapshots while prospective offerings change", async t => {
  for (const live of [false, true]) {
    const f = setup(t); await f.save(baseServices);
    f.sql.exec(`INSERT INTO booking_requests(id,resident_user_id,helper_user_id,resident_address_id,package_snapshot_json,monthly_price_paise,requested_start_date,status,response_due_at) VALUES ('request','resident','helper','address','{"service":"utensils_once","homeSize":"one_two_bhk"}',50000,'2099-01-01','${live ? "accepted" : "pending"}',datetime('now','+1 day'))`);
    if (live) f.sql.exec("INSERT INTO bookings(id,request_id,resident_user_id,helper_user_id,status,cycle_started_at,cycle_ends_at) VALUES ('booking','request','resident','helper','active','2099-01-01','2099-02-01')");
    const history = f.sql.prepare("SELECT * FROM booking_requests").all();
    assert.equal((await f.save({ houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: 60_000 }], utensils: null })).status, 200);
    assert.deepEqual(f.sql.prepare("SELECT * FROM booking_requests").all(), history);
    assert.equal(f.rows().find(row => row.service_type === "utensils_once").is_active, 0);
    assert.equal(f.rows().find(row => row.service_type === "house_cleaning").is_active, 1);
  }
});

test("rendered service editor shows sizes, durations, one utensil base price and derived twice price", t => {
  const f = setup(t); const { HelperServicePricing } = f.load("app/components/helper-service-pricing.tsx");
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(HelperServicePricing, {
    offeringState: "conforming", servicesChanged: false,
    houseSizes: { oneTwo: true, three: true, fourPlus: true }, setHouseSizes: noop,
    housePrices: { oneTwo: "600", three: "700", fourPlus: "800" }, setHousePrices: noop,
    utensilsEnabled: true, setUtensilsEnabled: noop, utensilsTwice: true, setUtensilsTwice: noop,
    utensilsOncePrice: "500.25", setUtensilsOncePrice: noop, markChanged: noop,
  }));
  for (const text of ["1–2 BHK", "3 BHK", "4+ BHK", "30 minutes", "45 minutes", "60 minutes", "Once daily", "Twice daily", "Twice-daily price: ₹1,000.5 monthly"]) assert.match(html, new RegExp(text.replace(/[+]/g, "\\+")));
  assert.equal((html.match(/Once-daily monthly price/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Twice-daily monthly price[^:]/);
  const source = readFileSync("app/page.tsx", "utf8");
  assert.match(source, /servicesChanged \|\| offeringState === "none"/);
  assert.doesNotMatch(readFileSync("app/components/helper-service-pricing.tsx", "utf8"), /resident total|platform fee|payment fee/i);
});

test("rendered inconsistent legacy state requires explicit replacement", t => {
  const f = setup(t); const { HelperServicePricing } = f.load("app/components/helper-service-pricing.tsx"); const noop = () => {};
  const html = renderToStaticMarkup(createElement(HelperServicePricing, { offeringState: "legacy_inconsistent", servicesChanged: false, houseSizes: { oneTwo: false, three: false, fourPlus: false }, setHouseSizes: noop, housePrices: { oneTwo: "", three: "", fourPlus: "" }, setHousePrices: noop, utensilsEnabled: false, setUtensilsEnabled: noop, utensilsTwice: false, setUtensilsTwice: noop, utensilsOncePrice: "", setUtensilsOncePrice: noop, markChanged: noop }));
  assert.match(html, /stay unchanged/); assert.match(html, /Replace saved services and prices/); assert.doesNotMatch(html, /30 minutes/);
});
