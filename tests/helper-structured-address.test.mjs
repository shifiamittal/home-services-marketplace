import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixture, jsonRequest, profilePayload } from "./helpers/local-routes.mjs";
import { png } from "./helpers/proof-images.mjs";
import { detectHelperLocation } from "../app/lib/helper-location.ts";
import { formattedHelperAddress, parseHelperAddress } from "../app/lib/helper-address.ts";

const route = "app/api/helper/profile/route.ts";
const address = {
  houseOrFlat: "42A",
  floor: "Second floor",
  buildingOrSociety: "Lotus Complex",
  city: "Pune",
  state: "Maharashtra",
  pinCode: "411001",
};

function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.save = extra => f.load(route).PUT(jsonRequest({ ...profilePayload, locality: undefined, homeAddress: undefined, address, ...extra }));
  f.profile = () => f.sql.prepare("SELECT * FROM helper_profiles WHERE user_id='helper'").get();
  return f;
}

async function uploadProof(f) {
  const form = new FormData();
  form.append("file", new File([png], "proof.png", { type: "image/png" }));
  return f.load("app/api/helper/address-proof/route.ts").POST(new Request("https://example.test/api", {
    method: "POST", headers: { origin: "https://example.test" }, body: form,
  }));
}

test("proof-created placeholder cannot be preserved or published after refresh", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  f.sql.exec("DELETE FROM verification_documents; DELETE FROM helper_profiles");
  assert.equal((await uploadProof(f)).status, 200);
  const loaded = await (await f.load(route).GET(new Request("https://example.test/api"))).json();
  const response = await f.load(route).PUT(jsonRequest({
    ...profilePayload, locality: undefined, homeAddress: undefined, preserveAddress: true,
  }));
  assert.equal(response.status, 409);
  assert.equal(loaded.profile.addressState, "none");
  assert.equal(loaded.profile.legacyAddress, null);
  assert.equal(f.sql.prepare("SELECT profile_status FROM helper_profiles WHERE user_id='helper'").get().profile_status, "draft");
});

for (const [homeAddress, homeLocality] of [[null, ""], [null, " \t\u00a0"], ["", ""], [" \n", "\ufeff"]]) {
  test(`blank legacy fields are address state none and cannot be preserved: ${JSON.stringify([homeAddress, homeLocality])}`, async t => {
    const f = fixture(); t.after(() => f.sql.close());
    f.sql.prepare("UPDATE helper_profiles SET home_address=?,home_locality=?,profile_status='draft'").run(homeAddress, homeLocality);
    const loaded = await (await f.load(route).GET(new Request("https://example.test/api"))).json();
    assert.equal(loaded.profile.addressState, "none");
    assert.equal(loaded.profile.legacyAddress, null);
    const response = await f.load(route).PUT(jsonRequest({
      ...profilePayload, locality: undefined, homeAddress: undefined, preserveAddress: true,
    }));
    assert.equal(response.status, 409);
    assert.equal(f.sql.prepare("SELECT profile_status FROM helper_profiles WHERE user_id='helper'").get().profile_status, "draft");
  });
}

test("shared address-state classifier rejects null and whitespace placeholders", t => {
  const f = fixture(); t.after(() => f.sql.close());
  const { helperAddressState } = f.load("app/lib/helper-address-state.ts");
  assert.equal(helperAddressState({ home_address: null, home_locality: null }), "none");
  assert.equal(helperAddressState({ home_address: " \t", home_locality: "\u00a0" }), "none");
  assert.equal(helperAddressState({ home_address: null, home_locality: "Pune" }), "legacy");
  assert.equal(helperAddressState({
    house_or_flat: address.houseOrFlat, floor: address.floor, building_or_society: address.buildingOrSociety,
    city: address.city, state: address.state, pin_code: address.pinCode, home_address: "", home_locality: "",
  }), "structured");
});

test("location permission is requested only when detection is invoked and success returns reverse-geocoded fields", async () => {
  let requests = 0;
  const geolocation = { getCurrentPosition(success) { requests += 1; success({ coords: { latitude: 18.52, longitude: 73.85 } }); } };
  assert.equal(requests, 0);
  const detected = await detectHelperLocation(geolocation, async (latitude, longitude) => {
    assert.deepEqual([latitude, longitude], [18.52, 73.85]);
    return address;
  });
  assert.equal(requests, 1);
  assert.deepEqual(detected, { address, latitude: 18.52, longitude: 73.85 });
});

test("permission denial and detection/geocoding failures return manual-entry guidance", async () => {
  const unusedReverseGeocode = async () => address;
  await assert.rejects(detectHelperLocation({ getCurrentPosition(_success, failure) { failure({ code: 1 }); } }, unusedReverseGeocode), /denied.*manually/i);
  await assert.rejects(detectHelperLocation({ getCurrentPosition(_success, failure) { failure({ code: 2 }); } }, unusedReverseGeocode), /detect.*manually/i);
  await assert.rejects(detectHelperLocation({ getCurrentPosition(success) { success({ coords: { latitude: 1, longitude: 2 } }); } }, async () => { throw Error("synthetic"); }), /identify.*manually/i);
  await assert.rejects(detectHelperLocation(undefined, unusedReverseGeocode), /not supported.*manually/i);
});

test("manual address accepts optional fields and requires only house, city, state and six-digit PIN", () => {
  assert.deepEqual(parseHelperAddress({ ...address, floor: "", buildingOrSociety: "" }), { ...address, floor: "", buildingOrSociety: "" });
  for (const field of ["houseOrFlat", "city", "state"]) assert.throws(() => parseHelperAddress({ ...address, [field]: "  " }));
  for (const pinCode of ["", "41100", "41100A", "4110011"]) assert.throws(() => parseHelperAddress({ ...address, pinCode }));
  assert.equal(formattedHelperAddress(address), "42A, Second floor, Lotus Complex, Pune, Maharashtra, 411001");
});

test("helper UI exposes only the requested structured fields and explicit detection/manual fallback", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  const setupStart = source.indexOf('{view === "setup"');
  const setup = source.slice(setupStart, source.indexOf('{view === "incoming"', setupStart));
  assert.match(setup, /Use my current location/);
  for (const label of ["House or flat number", "Floor (optional)", "Building, complex or society (optional)", "City", "State", "PIN code"]) assert.ok(setup.includes(label), `missing ${label}`);
  assert.doesNotMatch(setup, /GoogleAddressField|label="(?:Area|Locality|Landmark|Address label)"|draggable|interactive map/i);
  assert.match(source, /onClick=\{\(\) => void detectHelperCurrentLocation\(\)\}/);
  assert.match(source, /setHelperCoordinates\(null\)/);
  assert.match(source, /addressState === "legacy" && result\.profile\.legacyAddress/);
});

test("structured address persists every field and detected coordinates through refresh", async t => {
  const f = setup(t);
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85 })).status, 200);
  assert.deepEqual({
    houseOrFlat: f.profile().house_or_flat, floor: f.profile().floor,
    buildingOrSociety: f.profile().building_or_society, city: f.profile().city,
    state: f.profile().state, pinCode: f.profile().pin_code,
  }, address);
  const loaded = await (await f.load(route).GET(new Request("https://example.test/api"))).json();
  assert.deepEqual(loaded.profile.address, address);
  assert.equal(loaded.profile.legacyAddress, null);
  assert.equal(loaded.profile.latitude, 18.52);
  assert.equal(loaded.profile.longitude, 73.85);
});

test("canonical whitespace equivalence preserves coordinates and verification", async t => {
  const f = setup(t);
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85 })).status, 200);
  f.sql.exec("UPDATE helper_profiles SET verification_status='verified'; UPDATE verification_documents SET status='verified'");
  const equivalent = { ...address, houseOrFlat: "  42A\t", buildingOrSociety: "Lotus   Complex", city: " Pune " };
  assert.equal((await f.save({ address: equivalent, latitude: undefined, longitude: undefined })).status, 200);
  assert.equal(f.profile().verification_status, "verified");
  assert.equal(f.profile().latitude_e6, 18520000);
  assert.equal(f.profile().longitude_e6, 73850000);
  assert.equal(f.profile().home_address, formattedHelperAddress(address));
});

test("client-forged preservation is rejected for a structured profile", async t => {
  const f = setup(t);
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85 })).status, 200);
  const before = f.profile();
  const response = await f.load(route).PUT(jsonRequest({
    ...profilePayload, locality: undefined, homeAddress: undefined, preserveAddress: true, yearsExperience: 11,
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(f.profile(), before);
});

test("manual correction clears coordinates and invalidates completed verification", async t => {
  const f = setup(t);
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85 })).status, 200);
  f.sql.exec("UPDATE helper_profiles SET verification_status='verified'; UPDATE verification_documents SET status='verified'");
  assert.equal((await f.save({ address: { ...address, houseOrFlat: "43B" }, latitude: null, longitude: null })).status, 200);
  assert.equal(f.profile().latitude_e6, null);
  assert.equal(f.profile().longitude_e6, null);
  assert.equal(f.profile().verification_status, "pending");
  assert.equal(f.sql.prepare("SELECT status FROM verification_documents WHERE id='proof'").get().status, "pending");
});

test("unrelated edits preserve structured or legacy address, coordinates and verification", async t => {
  const f = setup(t);
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85 })).status, 200);
  f.sql.exec("UPDATE helper_profiles SET verification_status='verified'; UPDATE verification_documents SET status='verified'");
  const before = f.profile();
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85, yearsExperience: 8 })).status, 200);
  const after = f.profile();
  for (const field of ["home_address", "home_locality", "house_or_flat", "floor", "building_or_society", "city", "state", "pin_code", "latitude_e6", "longitude_e6", "verification_status"]) assert.equal(after[field], before[field]);
  assert.equal(after.years_experience, 8);

  f.sql.exec("UPDATE helper_profiles SET house_or_flat=NULL,floor=NULL,building_or_society=NULL,city=NULL,state=NULL,pin_code=NULL,home_address='Legacy home',home_locality='Legacy city',latitude_e6=10000000,longitude_e6=20000000,verification_status='verified'");
  const legacy = await (await f.load(route).GET(new Request("https://example.test/api"))).json();
  assert.equal(legacy.profile.addressState, "legacy");
  assert.equal(legacy.profile.address, null);
  assert.equal(legacy.profile.legacyAddress, "Legacy home");
  assert.equal((await f.load(route).PUT(jsonRequest({ ...profilePayload, locality: undefined, homeAddress: undefined, preserveAddress: true, yearsExperience: 9 }))).status, 200);
  assert.equal(f.profile().home_address, "Legacy home");
  assert.equal(f.profile().latitude_e6, 10000000);
  assert.equal(f.profile().verification_status, "verified");
});

test("proof replacement racing a structured profile save commits one complete address", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  f.objects.set("fixture/old.pdf", new Uint8Array([1, 2, 3]));
  f.db.beforeBatch = async () => assert.equal((await uploadProof(f)).status, 200);
  const response = await f.load(route).PUT(jsonRequest({
    ...profilePayload, locality: undefined, homeAddress: undefined, address, latitude: 18.52, longitude: 73.85,
  }));
  assert.equal(response.status, 200);
  const loaded = await (await f.load(route).GET(new Request("https://example.test/api"))).json();
  assert.equal(loaded.profile.addressState, "structured");
  assert.deepEqual(loaded.profile.address, address);
  assert.equal(f.sql.prepare("SELECT profile_status FROM helper_profiles WHERE user_id='helper'").get().profile_status, "active");
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM verification_documents WHERE helper_user_id='helper' AND status='pending'").get().n, 1);
});

test("structured address failure rolls back fields, coordinates, verification and audit", async t => {
  const f = setup(t);
  assert.equal((await f.save({ latitude: 18.52, longitude: 73.85 })).status, 200);
  f.sql.exec("UPDATE helper_profiles SET verification_status='verified'; UPDATE verification_documents SET status='verified'; CREATE TRIGGER fail_structured BEFORE UPDATE OF city ON helper_profiles BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  const before = f.profile();
  const audits = f.sql.prepare("SELECT count(*) AS n FROM analytics_events").get().n;
  assert.equal((await f.save({ address: { ...address, city: "Mumbai" }, latitude: null, longitude: null })).status, 500);
  assert.deepEqual(f.profile(), before);
  assert.equal(f.sql.prepare("SELECT status FROM verification_documents WHERE id='proof'").get().status, "verified");
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM analytics_events").get().n, audits);
});

test("migration is forward-only and leaves legacy rows representable", t => {
  const f = fixture(); t.after(() => f.sql.close());
  const columns = new Set(f.sql.prepare("PRAGMA table_info(helper_profiles)").all().map(row => row.name));
  for (const column of ["house_or_flat", "floor", "building_or_society", "city", "state", "pin_code"]) assert.ok(columns.has(column));
  const row = f.sql.prepare("SELECT house_or_flat,floor,building_or_society,city,state,pin_code FROM helper_profiles WHERE user_id='helper'").get();
  assert.deepEqual({ ...row }, { house_or_flat: null, floor: null, building_or_society: null, city: null, state: null, pin_code: null });
});
