import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonRequest, profilePayload } from "./helpers/local-routes.mjs";

const NOW = "2030-01-07T10:00:00.000Z";
const addressRoute = "app/api/resident/address/route.ts";
const requestRoute = "app/api/resident/requests/route.ts";
const helperRequests = "app/api/helper/requests/route.ts";
const matchesRoute = "app/api/resident/matches/route.ts";
const address = { house: "Synthetic unit", formattedAddress: "Synthetic road", locality: "Synthetic district", latitude: 10, longitude: 20 };
const wanted = { helperId: "helper", service: "utensils_once", homeSize: "one_two_bhk", firstTime: "08:00", requestedStartDate: "2030-01-08", flexibilityMinutes: 30 };

function setup(t) {
  const clock = { now: NOW };
  const f = fixture({ clock });
  t.after(() => f.sql.close());
  f.clock = clock;
  asResident(f);
  f.sql.exec(`UPDATE helper_profiles SET latitude_e6=10000000, longitude_e6=20000000;
    INSERT INTO helper_offerings(id,helper_user_id,service_type,home_size,monthly_price_paise)
    VALUES ('once','helper','utensils_once','not_applicable',50000),('twice','helper','utensils_twice','not_applicable',100000);`);
  for (let day = 1; day <= 6; day++) f.sql.prepare(`INSERT INTO availability_slots
    (id,helper_user_id,day_of_week,start_minute,end_minute,status) VALUES (?,'helper',?,420,900,'open')`).run(`slot-${day}`, day);
  return f;
}
function asResident(f, id = "resident") { Object.assign(f.session, { user_id: id, role: "resident", roles: ["resident"] }); }
function asHelper(f, id = "helper") { Object.assign(f.session, { user_id: id, role: "provider", roles: ["provider"] }); }
function seedRequest(f, { id = "prior", status = "pending", booking, due = "2030-01-08T10:00:00.000Z", resident = "resident" } = {}) {
  f.sql.prepare(`INSERT INTO booking_requests
    (id,resident_user_id,helper_user_id,resident_address_id,package_snapshot_json,monthly_price_paise,requested_start_date,status,response_due_at)
    VALUES (?,?,'helper','address','{"service":"utensils_once"}',50000,'2030-01-08',?,?)`).run(id, resident, status, due);
  for (let day = 1; day <= 6; day++) f.sql.prepare(`INSERT INTO request_slots
    (id,request_id,availability_slot_id,visit_ordinal,day_of_week,start_minute,end_minute)
    VALUES (?,?,?,1,?,720,750)`).run(`${id}-${day}`, id, `slot-${day}`, day);
  if (booking) f.sql.prepare(`INSERT INTO bookings
    (id,request_id,resident_user_id,helper_user_id,status,cycle_started_at,cycle_ends_at)
    VALUES (?,?,?,'helper',?,'2030-01-08','2030-02-08')`).run(`booking-${id}`, id, resident, booking);
}
function count(f, table) { return f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }
function onMutation(f, action) {
  f.db.beforeBatch = async function hook(statements) {
    if (statements.some(s => /INSERT INTO booking_requests/.test(s.query))) await action();
    else f.db.beforeBatch = hook;
  };
}

test("R2-1 resident null coordinates remain unavailable, never manufactured zero", async t => {
  const f = setup(t);
  const response = await f.load(addressRoute).PUT(jsonRequest({ ...address, latitude: null, longitude: null }));
  assert.equal(response.status, 200);
  const saved = f.sql.prepare("SELECT latitude_e6,longitude_e6 FROM resident_addresses WHERE is_primary=1").get();
  assert.deepEqual({ ...saved }, { latitude_e6: null, longitude_e6: null });
});

test("R2-2 address edits preserve the contents referenced by an active booking", async t => {
  const f = setup(t);
  seedRequest(f, { status: "accepted", booking: "active" });
  const before = f.sql.prepare("SELECT house_or_flat,street_or_block,locality,latitude_e6,longitude_e6 FROM resident_addresses WHERE id='address'").get();
  assert.equal((await f.load(addressRoute).PUT(jsonRequest(address))).status, 200);
  assert.deepEqual(f.sql.prepare("SELECT house_or_flat,street_or_block,locality,latitude_e6,longitude_e6 FROM resident_addresses WHERE id='address'").get(), before);
  assert.notEqual(f.sql.prepare("SELECT id FROM resident_addresses WHERE is_primary=1").get().id, "address");
  assert.equal(f.sql.prepare("SELECT resident_address_id FROM booking_requests WHERE id='prior'").get().resident_address_id, "address");
});

test("R2-3 a live SQLite-formatted deadline is not expired by an ISO cutoff", async t => {
  const f = setup(t);
  seedRequest(f, { due: "2030-01-07 10:00:00.001" });
  await f.load("app/lib/workflow-integrity.ts").expirePendingRequests(f.db);
  assert.equal(f.sql.prepare("SELECT status FROM booking_requests WHERE id='prior'").get().status, "pending");
});

test("R2-4 a direct request cannot target a blocked helper user", async t => {
  const f = setup(t);
  f.sql.exec("UPDATE users SET status='blocked' WHERE id='helper'");
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "booking_requests"), 0);
});

test("R2-5 a live booking created after the lifecycle pre-read prevents a new request", async t => {
  const f = setup(t);
  onMutation(f, () => seedRequest(f, { status: "accepted", booking: "trial" }));
  const response = await f.load(requestRoute).POST(jsonRequest(wanted, "POST"));
  assert.equal(response.status, 409);
  assert.equal(count(f, "booking_requests"), 1);
  assert.equal(count(f, "slot_claims"), 0);
});

test("R2-6 pre-acceptance legacy locality never discloses precise address content", async t => {
  const f = setup(t);
  seedRequest(f);
  f.sql.exec("UPDATE resident_addresses SET locality='SENTINEL_PRIVATE_LOCATION',street_or_block='SENTINEL_PRIVATE_LOCATION',house_or_flat='SENTINEL_PRIVATE_LOCATION'");
  asHelper(f);
  const response = await f.load(helperRequests).GET(new Request("https://example.test/api"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.pendingRequest.residentAddress, null);
  assert.equal(body.pendingRequest.residentLocality, null);
  assert.equal(JSON.stringify(body).includes("SENTINEL_PRIVATE_LOCATION"), false);
});

test("R2-7 legacy twice-daily matching finds a feasible pair missed by greedy choices", async t => {
  const f = setup(t);
  const response = await f.load(matchesRoute).POST(jsonRequest({ ...wanted, service: "utensils_twice", secondTime: "08:30" }, "POST"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.matches.length, 1);
  const { firstTime, secondTime, timeDifferenceMinutes } = body.matches[0];
  assert.notEqual(firstTime, secondTime);
  assert.equal(timeDifferenceMinutes, 15);
});

for (const route of [addressRoute, "app/api/account/complete/route.ts", "app/api/helper/profile/route.ts"]) {
  test(`coordinate boundary and valid zero-axis paths: ${route}`, async t => {
    const f = setup(t);
    const isHelper = route.includes("helper/profile"), isAccount = route.includes("account/complete");
    if (isHelper) asHelper(f);
    const base = isHelper ? profilePayload : { ...address, role: "resident", name: "Synthetic resident", termsAccepted: true };
    const save = payload => f.load(route)[isAccount ? "POST" : "PUT"](jsonRequest(payload, isAccount ? "POST" : "PUT"));
    const read = () => f.sql.prepare(isHelper
      ? "SELECT latitude_e6,longitude_e6 FROM helper_profiles WHERE user_id='helper'"
      : "SELECT latitude_e6,longitude_e6 FROM resident_addresses WHERE resident_user_id='resident' AND is_primary=1").get();
    for (const value of [undefined, null, "", "  "]) {
      // Change location text: omitted coordinates cannot be inherited from an old location.
      const payload = { ...base, locality: `Synthetic ${String(value)}`, latitude: value, longitude: value };
      assert.equal((await save(payload)).status, 200);
      assert.equal(read().latitude_e6, null);
      assert.equal(read().longitude_e6, null);
    }
    for (const [latitude, longitude] of [[0, 20], [10, 0], [10.125, -20.5], [-90, 180]]) {
      assert.equal((await save({ ...base, latitude, longitude })).status, 200);
      assert.equal(read().latitude_e6 === Math.round(latitude * 1e6), true);
      assert.equal(read().longitude_e6 === Math.round(longitude * 1e6), true);
    }
    for (const [latitude, longitude] of [[0, 0], [null, 20], [10, undefined], ["10", "20"], ["no", "no"],
      [91, 20], [10, -181], [Infinity, 20], [10, NaN], [true, false]]) {
      const before = read();
      assert.equal((await save({ ...base, latitude, longitude })).status, 400);
      assert.deepEqual(read(), before);
    }
    assert.equal((await save(base)).status, 200);
    const before = read();
    const edited = { ...base, name: "Synthetic changed", yearsExperience: 3, latitude: undefined, longitude: undefined };
    assert.equal((await save(edited)).status, 200);
    assert.deepEqual(read(), before);
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("coordinate utility rejects non-finite/coercible primitives and getters hide invalid stored pairs", async t => {
  const f = setup(t);
  const { coordinates } = f.load("app/lib/address-integrity.ts");
  for (const v of [NaN, Infinity, -Infinity, {}, [10], new Number(10)]) assert.throws(() => coordinates(v, 20), /Invalid coordinate pair/);
  for (const [lat, lon] of [[null, 20], [0, 0], [91000000, 20]]) {
    f.sql.prepare("UPDATE resident_addresses SET latitude_e6=?,longitude_e6=?").run(lat, lon);
    const body = await (await f.load(addressRoute).GET(new Request("https://example.test/api"))).json();
    assert.equal(body.address.latitude, null);
    assert.equal(body.address.longitude, null);
    assert.equal((await f.load(matchesRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  }
});

for (const history of ["none", "pending", "trial", "active", "completed"]) {
  test(`address revisions preserve ${history} history across successive edits`, async t => {
    const f = setup(t);
    if (history !== "none") seedRequest(f, history === "pending" ? {} : { status: "accepted", booking: history });
    const historical = () => f.sql.prepare("SELECT house_or_flat,street_or_block,locality,latitude_e6,longitude_e6 FROM resident_addresses WHERE id='address'").get();
    const before = historical();
    let previous = "address";
    for (let edit = 0; edit < 3; edit++) {
      assert.equal((await f.load(addressRoute).PUT(jsonRequest({ ...address, house: `Synthetic unit ${edit}` }))).status, 200);
      const current = f.sql.prepare("SELECT id,house_or_flat FROM resident_addresses WHERE is_primary=1").get();
      assert.notEqual(current.id, previous);
      assert.equal(count(f, "resident_addresses"), edit + 2);
      assert.deepEqual(historical(), before);
      previous = current.id;
    }
    if (["none", "completed"].includes(history)) {
      assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 200);
      assert.equal(f.sql.prepare("SELECT resident_address_id FROM booking_requests WHERE status='pending'").get().resident_address_id, previous);
    }
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("address revision rollback and ownership keep all historical rows intact", async t => {
  const f = setup(t);
  const before = f.sql.prepare("SELECT * FROM resident_addresses").all();
  f.db.beforeStatement = (index, statement) => { if (statement.query.startsWith("UPDATE resident_addresses")) throw Error("synthetic failure"); };
  assert.equal((await f.load(addressRoute).PUT(jsonRequest(address))).status, 500);
  assert.deepEqual(f.sql.prepare("SELECT * FROM resident_addresses").all(), before);
  f.db.beforeStatement = null;
  addResident(f);
  asResident(f, "other");
  assert.equal((await f.load(addressRoute).PUT(jsonRequest({ ...address, id: "address", residentId: "resident" }))).status, 200);
  assert.deepEqual(f.sql.prepare("SELECT * FROM resident_addresses WHERE resident_user_id='resident'").all(), before);
  asHelper(f);
  assert.equal((await f.load(addressRoute).PUT(jsonRequest(address))).status, 403);
});

const deadlineCases = [
  ["iso-before", "2030-01-07T09:59:59.999Z", false],
  ["iso-boundary", NOW, false], ["iso-after", "2030-01-07T10:00:00.001Z", true],
  ["sqlite-before", "2030-01-07 09:59:59.999", false],
  ["sqlite-boundary", "2030-01-07 10:00:00", false], ["sqlite-after", "2030-01-07 10:00:00.001", true],
  ["offset-before", "2030-01-07T15:29:59.999+05:30", false],
  ["offset-boundary", "2030-01-07T15:30:00+05:30", false],
  ["offset-after", "2030-01-07T05:00:00.001-05:00", true],
  ["malformed", "not-a-timestamp", false], ["blank", "", false],
  ["numeric", "3000000", false], ["invalid-calendar", "2030-02-30T10:00:00Z", false],
];
for (const [label, due, live] of deadlineCases) {
  test(`deadline chronology and acceptance fail closed: ${label}`, async t => {
    const f = setup(t);
    seedRequest(f, { due });
    f.sql.exec("INSERT INTO slot_claims(id,helper_user_id,day_of_week,minute_of_day,request_id) VALUES ('held','helper',1,720,'prior')");
    await f.load("app/lib/workflow-integrity.ts").expirePendingRequests(f.db);
    assert.equal(f.sql.prepare("SELECT status FROM booking_requests WHERE id='prior'").get().status, live ? "pending" : "expired");
    assert.equal(count(f, "slot_claims"), live ? 1 : 0);
    asHelper(f);
    const result = await f.load(helperRequests).POST(jsonRequest({ requestId: "prior", decision: "accept" }, "POST"));
    assert.equal(result.status, live ? 200 : 409);
    assert.equal(count(f, "bookings"), live ? 1 : 0);
  });
}

test("acceptance rechecks a deadline crossed after the pre-read and rolls back", async t => {
  const f = setup(t);
  seedRequest(f, { due: "2030-01-07T10:00:01Z" });
  asHelper(f);
  f.db.beforeBatch = function hook(statements) {
    if (statements.some(s => /INSERT INTO bookings/.test(s.query))) f.clock.now = "2030-01-07T10:00:01Z";
    else f.db.beforeBatch = hook;
  };
  assert.equal((await f.load(helperRequests).POST(jsonRequest({ requestId: "prior", decision: "accept" }, "POST"))).status, 409);
  assert.equal(count(f, "bookings"), 0);
  assert.equal(count(f, "workflow_transitions"), 0);
});

test("expired holds beyond the global cleanup batch cannot reserve the requested slot", async t => {
  const f = setup(t);
  for (let index = 0; index < 51; index++) {
    const id = `backlog-${index}`;
    f.sql.prepare("INSERT INTO users(id,name,mobile_e164) VALUES (?,'Synthetic backlog',?)").run(id, `synthetic-${index}`);
    seedRequest(f, { id, resident: id, due: index < 50 ? "2000-01-01 00:00:00" : "2001-01-01 00:00:00" });
  }
  f.sql.exec("INSERT INTO slot_claims(id,helper_user_id,day_of_week,minute_of_day,request_id) VALUES ('expired-held','helper',1,480,'backlog-50')");
  const response = await f.load(requestRoute).POST(jsonRequest(wanted, "POST"));
  assert.equal(response.status, 200);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE id='expired-held'").get().n, 0);
});

for (const [kind, status] of [["user", "active"], ["user", "inactive"], ["user", "paused"], ["user", "blocked"], ["user", "deleted"],
  ["profile", "paused"], ["profile", "blocked"], ["profile", "review"], ["profile", "draft"], ["missing", "missing"]]) {
  test(`direct helper admission: ${kind}/${status}`, async t => {
    const f = setup(t);
    if (kind === "user") f.sql.prepare("UPDATE users SET status=? WHERE id='helper'").run(status);
    if (kind === "profile") f.sql.prepare("UPDATE helper_profiles SET profile_status=? WHERE user_id='helper'").run(status);
    const result = await f.load(requestRoute).POST(jsonRequest({ ...wanted, helperId: kind === "missing" ? "absent" : "helper" }, "POST"));
    assert.equal(result.status, status === "active" ? 200 : 409);
    assert.equal(count(f, "booking_requests"), status === "active" ? 1 : 0);
  });
}

test("helper status changed after the pre-read cannot authorize a request", async t => {
  const f = setup(t);
  onMutation(f, () => f.sql.exec("UPDATE helper_profiles SET profile_status='paused' WHERE user_id='helper'"));
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "booking_requests"), 0);
  assert.equal(count(f, "slot_claims"), 0);
});

test("two simultaneous requests use the existing unique index and atomic admission", async t => {
  const f = setup(t);
  const route = f.load(requestRoute);
  const responses = await Promise.all([route.POST(jsonRequest(wanted, "POST")), route.POST(jsonRequest(wanted, "POST"))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(count(f, "booking_requests"), 1);
  assert.equal(count(f, "request_slots"), 6);
  assert.equal(count(f, "slot_claims"), 270);
});

function addResident(f) {
  f.sql.exec(`INSERT INTO users(id,name,mobile_e164) VALUES ('other','Synthetic other','+10000000002');
    INSERT INTO resident_profiles(user_id) VALUES ('other');
    INSERT INTO resident_addresses(id,resident_user_id,house_or_flat,locality,latitude_e6,longitude_e6,is_primary)
    VALUES ('other-address','other','Synthetic','Synthetic',10000000,20000000,1);`);
}

test("independent residents with nonconflicting times both succeed", async t => {
  const f = setup(t);
  addResident(f);
  const route = f.load(requestRoute);
  const first = route.POST(jsonRequest(wanted, "POST"));
  asResident(f, "other");
  const second = route.POST(jsonRequest({ ...wanted, firstTime: "09:00" }, "POST"));
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal(count(f, "booking_requests"), 2);
});

for (const status of ["trial", "active", "ending"]) {
  test(`request admission rechecks a concurrent ${status} booking`, async t => {
    const f = setup(t);
    onMutation(f, () => seedRequest(f, { status: "accepted", booking: status }));
    assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
    assert.equal(count(f, "bookings"), 1);
    assert.equal(count(f, "booking_requests"), 1);
    assert.equal(count(f, "request_slots"), 6);
  });
}

test("request racing the actual helper acceptance handler cannot create a second lifecycle", async t => {
  const f = setup(t);
  onMutation(f, async () => {
    seedRequest(f);
    asHelper(f);
    assert.equal((await f.load(helperRequests).POST(jsonRequest({ requestId: "prior", decision: "accept" }, "POST"))).status, 200);
    asResident(f);
  });
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "bookings"), 1);
  assert.equal(count(f, "booking_requests"), 1);
});

for (const change of ["name", "status", "address", "profile"]) {
  test(`stale resident ${change} cannot authorize a request`, async t => {
    const f = setup(t);
    onMutation(f, () => f.sql.exec({ name: "UPDATE users SET name='' WHERE id='resident'", status: "UPDATE users SET status='blocked' WHERE id='resident'",
      address: "UPDATE resident_addresses SET is_primary=0 WHERE resident_user_id='resident'", profile: "DELETE FROM resident_profiles WHERE user_id='resident'" }[change]));
    assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
    assert.equal(count(f, "slot_claims"), 0);
  });
}

test("mutation failure rolls back request, claims, slots, notifications and permits retry", async t => {
  const f = setup(t);
  f.db.beforeStatement = (index, statement) => { if (statement.query.includes("INSERT INTO notification_log")) throw Error("synthetic failure"); };
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 500);
  for (const table of ["booking_requests", "request_slots", "slot_claims", "notification_log", "analytics_events"]) assert.equal(count(f, table), 0);
  f.db.beforeStatement = null;
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 200);
});

for (const state of ["pending", "accepted", "declined", "expired"]) {
  test(`helper address serializer and ownership: ${state}`, async t => {
    const f = setup(t);
    seedRequest(f, { status: state, booking: state === "accepted" ? "active" : undefined });
    asHelper(f);
    const body = await (await f.load(helperRequests).GET(new Request("https://example.test/api"))).json();
    if (state === "pending") assert.deepEqual({ locality: body.pendingRequest.residentLocality, address: body.pendingRequest.residentAddress, mobile: body.pendingRequest.residentMobile }, { locality: null, address: null, mobile: null });
    if (state === "accepted") {
      assert.equal(body.activeBooking.residentLocality, "Fixture");
      assert.equal(body.activeBooking.residentAddress, "Fixture, Fixture");
    }
    if (["declined", "expired"].includes(state)) assert.equal(body.pendingRequest, null);
    asHelper(f, "unrelated");
    const unrelated = await (await f.load(helperRequests).GET(new Request("https://example.test/api"))).json();
    assert.equal(unrelated.pendingRequest, null);
    assert.deepEqual(unrelated.activeBookings, []);
    assert.equal((await f.load(helperRequests).POST(jsonRequest({ requestId: "prior", decision: "accept" }, "POST"))).status, 409);
    addResident(f); asResident(f, "other");
    const residentBody = await (await f.load(requestRoute).GET(new Request("https://example.test/api"))).json();
    assert.equal(residentBody.request, null);
    assert.deepEqual(f.logs, []);
  });
}

test("a foreign-owned legacy address is never disclosed even for an accepted request", async t => {
  const f = setup(t); addResident(f);
  seedRequest(f, { status: "accepted", booking: "active" });
  f.sql.exec("UPDATE booking_requests SET resident_address_id='other-address' WHERE id='prior'");
  asHelper(f);
  const body = await (await f.load(helperRequests).GET(new Request("https://example.test/api"))).json();
  assert.deepEqual(body.activeBookings, []);
});

for (const kind of ["no-pair", "duplicate", "claim"]) {
  test(`twice-daily feasibility excludes ${kind}`, async t => {
    const f = setup(t);
    const body = { ...wanted, service: "utensils_twice", secondTime: "08:30", flexibilityMinutes: 0 };
    if (kind === "no-pair") f.sql.exec("UPDATE availability_slots SET start_minute=480,end_minute=540");
    if (kind === "duplicate") body.secondTime = body.firstTime;
    if (kind === "claim") {
      addResident(f); seedRequest(f, { resident: "other" });
      f.sql.exec("UPDATE booking_requests SET resident_address_id='other-address' WHERE id='prior'; INSERT INTO slot_claims(id,helper_user_id,day_of_week,minute_of_day,request_id) VALUES ('claim','helper',1,480,'prior')");
      body.secondTime = "10:00";
    }
    const response = await f.load(matchesRoute).POST(jsonRequest(body, "POST"));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).matches, []);
  });
}

test("current-address revision drives new matches while historical content remains fixed", async t => {
  const f = setup(t);
  const matches = async () => (await (await f.load(matchesRoute).POST(jsonRequest(wanted, "POST"))).json()).matches;
  assert.equal((await matches())[0].distanceKm, 0);
  assert.equal((await f.load(addressRoute).PUT(jsonRequest({ ...address, latitude: 11 }))).status, 200);
  assert.equal((await matches())[0].distanceKm > 100, true);
  assert.equal(f.sql.prepare("SELECT latitude_e6=10000000 AS unchanged FROM resident_addresses WHERE id='address'").get().unchanged, 1);
});

test("address revision racing request creation causes conflict, then retry uses the latest revision", async t => {
  const f = setup(t);
  onMutation(f, async () => assert.equal((await f.load(addressRoute).PUT(jsonRequest(address))).status, 200));
  const route = f.load(requestRoute);
  assert.equal((await route.POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "booking_requests"), 0);
  assert.equal((await route.POST(jsonRequest(wanted, "POST"))).status, 200);
  assert.equal(f.sql.prepare("SELECT br.resident_address_id=ra.id AS current FROM booking_requests br JOIN resident_addresses ra ON ra.is_primary=1").get().current, 1);
});

test("concurrent address edits leave exactly one current revision and retain each prior row", async t => {
  const f = setup(t);
  const route = f.load(addressRoute);
  const results = await Promise.all([route.PUT(jsonRequest(address)), route.PUT(jsonRequest({ ...address, house: "Synthetic alternate" }))]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(count(f, "resident_addresses"), 3);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM resident_addresses WHERE is_primary=1").get().n, 1);
});

test("request ownership ignores client resident/address identifiers and forbids self-service", async t => {
  const f = setup(t); addResident(f);
  assert.equal((await f.load(requestRoute).POST(jsonRequest({ ...wanted, residentId: "other", addressId: "other-address" }, "POST"))).status, 200);
  const row = f.sql.prepare("SELECT resident_user_id,resident_address_id FROM booking_requests").get();
  assert.deepEqual({ ...row }, { resident_user_id: "resident", resident_address_id: "address" });
  asHelper(f);
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 403);
  f.sql.exec(`INSERT INTO resident_profiles(user_id) VALUES ('helper');
    INSERT INTO resident_addresses(id,resident_user_id,house_or_flat,locality,latitude_e6,longitude_e6,is_primary)
    VALUES ('self-address','helper','Synthetic','Synthetic',10000000,20000000,1);`);
  asResident(f, "helper");
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "booking_requests"), 1);
});

test("a helper user deactivated immediately before mutation cannot receive a request", async t => {
  const f = setup(t);
  onMutation(f, () => f.sql.exec("UPDATE users SET status='deleted' WHERE id='helper'"));
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "booking_requests"), 0);
});

test("a stalled new request cannot claim slots after its response deadline", async t => {
  const f = setup(t);
  onMutation(f, () => { f.clock.now = "2030-01-08T10:00:00.000Z"; });
  assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
  assert.equal(count(f, "slot_claims"), 0);
});

test("two actual acceptance handlers create only one booking and one set of visits", async t => {
  const f = setup(t); seedRequest(f); asHelper(f);
  const route = f.load(helperRequests);
  const body = { requestId: "prior", decision: "accept" };
  const results = await Promise.all([route.POST(jsonRequest(body, "POST")), route.POST(jsonRequest(body, "POST"))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(count(f, "bookings"), 1);
  assert.equal(count(f, "booking_slots"), 6);
  assert.equal(count(f, "service_visits"), 2);
});

test("acceptance racing withdrawal preserves the winner and never resurrects the request", async t => {
  const f = setup(t); seedRequest(f); asHelper(f);
  f.db.beforeBatch = async function hook(statements) {
    if (statements.some(s => /INSERT INTO bookings/.test(s.query))) {
      asResident(f);
      assert.equal((await f.load(requestRoute).DELETE(jsonRequest({ requestId: "prior" }, "DELETE"))).status, 200);
      asHelper(f);
    } else f.db.beforeBatch = hook;
  };
  assert.equal((await f.load(helperRequests).POST(jsonRequest({ requestId: "prior", decision: "accept" }, "POST"))).status, 409);
  assert.equal(f.sql.prepare("SELECT status FROM booking_requests WHERE id='prior'").get().status, "withdrawn");
  assert.equal(count(f, "bookings"), 0);
});

test("legacy pair ordering is deterministic under reversed availability insertion order", async t => {
  const f = setup(t);
  const body = { ...wanted, service: "utensils_twice", secondTime: "08:30" };
  const run = async () => (await (await f.load(matchesRoute).POST(jsonRequest(body, "POST"))).json()).matches;
  const before = await run();
  const rows = f.sql.prepare("SELECT * FROM availability_slots ORDER BY id DESC").all();
  f.sql.exec("DELETE FROM availability_slots");
  for (const row of rows) f.sql.prepare("INSERT INTO availability_slots(id,helper_user_id,day_of_week,start_minute,end_minute,status) VALUES (?,?,?,?,?,?)")
    .run(row.id, row.helper_user_id, row.day_of_week, row.start_minute, row.end_minute, row.status);
  assert.deepEqual(await run(), before);
  // Feed the actual displayed pair to the authoritative request handler.
  assert.equal((await f.load(requestRoute).POST(jsonRequest({ ...body, firstTime: before[0].firstTime, secondTime: before[0].secondTime }, "POST"))).status, 200);
  assert.equal(count(f, "request_slots"), 12);
});

const legacyLocations = [
  ["null street", null, "Fixture", 10000000, 20000000],
  ["empty street", "", "Fixture", 10000000, 20000000],
  ["whitespace street", " \t\n\u00a0", "Fixture", 10000000, 20000000],
  ["street and locality", "Synthetic road", "Fixture", 10000000, 20000000],
  ["missing locality", "Synthetic road", "", 10000000, 20000000],
  ["both absent", null, "", 10000000, 20000000],
  ["invalid stored pair", null, "Fixture", 10000000, null],
  ["zero latitude", null, "Fixture", 0, 20000000],
  ["zero longitude", null, "Fixture", 10000000, 0],
];
for (const [label, street, locality, lat, lon] of legacyLocations) {
  for (const operation of ["house", "unit", "normalized", "changed", "locality changed", "replacement", "partial", "invalid"]) {
    test(`legacy GET/PUT coordinate preservation: ${label}/${operation}`, async t => {
      const f = setup(t);
      f.sql.prepare("UPDATE resident_addresses SET street_or_block=?,locality=?,latitude_e6=?,longitude_e6=?").run(street, locality, lat, lon);
      f.sql.prepare("UPDATE helper_profiles SET latitude_e6=?,longitude_e6=?").run(lat, lon);
      const route = f.load(addressRoute);
      const complete = () => f.load("app/lib/profile-completeness.ts").residentProfileComplete(f.db, "resident");
      const beforeComplete = await complete();
      const original = f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get();
      const { address: read } = await (await route.GET(new Request("https://example.test/api"))).json();
      assert.equal(read.formattedAddress, street?.trim() || locality.trim());
      const payload = { ...read, house: operation === "unit" ? "Synthetic house, floor 2, unit 3" : "Synthetic new house" };
      delete payload.latitude; delete payload.longitude;
      if (operation === "normalized") {
        payload.formattedAddress = `\t ${payload.formattedAddress}\u00a0`;
        payload.locality = ` ${payload.locality}\n`;
      }
      if (operation === "changed") payload.formattedAddress = "Different synthetic road";
      if (operation === "locality changed") payload.locality = "Different synthetic district";
      if (operation === "replacement") Object.assign(payload, { latitude: 11, longitude: 21 });
      if (operation === "partial") payload.latitude = 11;
      if (operation === "invalid") Object.assign(payload, { latitude: 91, longitude: 21 });
      const rejected = !payload.locality.trim() || !payload.formattedAddress.trim() || ["partial", "invalid"].includes(operation);
      assert.equal((await route.PUT(jsonRequest(payload))).status, rejected ? 400 : 200);
      const current = f.sql.prepare("SELECT * FROM resident_addresses WHERE is_primary=1").get();
      if (rejected) {
        assert.deepEqual(current, original);
        assert.equal(count(f, "resident_addresses"), 1);
      } else {
        assert.notEqual(current.id, original.id);
        const preserved = !["changed", "locality changed", "replacement"].includes(operation) && lon !== null;
        const expected = operation === "replacement" ? [11000000, 21000000] : preserved ? [lat, lon] : [null, null];
        assert.deepEqual([current.latitude_e6, current.longitude_e6], expected);
        assert.deepEqual({ ...f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get() }, { ...original, is_primary: 0 });
        if (["house", "unit", "normalized"].includes(operation)) assert.equal(await complete(), beforeComplete);
        if (preserved && beforeComplete) {
          const matches = await f.load(matchesRoute).POST(jsonRequest(wanted, "POST"));
          assert.equal(matches.status, 200);
          assert.equal((await matches.json()).matches.length, 1);
          assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 200);
          assert.equal(f.sql.prepare("SELECT resident_address_id FROM booking_requests").get().resident_address_id, current.id);
        }
      }
      assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    });
  }
}

test("canonical location JS/atomic SQL parity, strict types and precise text distinctions", t => {
  const f = setup(t);
  const { effectiveLocationText, effectiveLocationTextSql } = f.load("app/lib/address-integrity.ts");
  const run = f.sql.prepare(`SELECT ${effectiveLocationTextSql('street', 'locality')} AS text FROM (SELECT ? AS street, ? AS locality)`);
  for (const street of [null, "", " \t\n\u00a0\u2003\ufeff", " Road ", "Road  unit 2", "road", 12]) {
    for (const locality of [null, "", " Fixture ", 7]) {
      assert.equal(run.get(street, locality).text, effectiveLocationText(street, locality));
    }
  }
  for (const value of [{}, [], true, new String("Road")]) assert.equal(effectiveLocationText(value, null), "");
  assert.notEqual(effectiveLocationText("Road unit 2", "Fixture"), effectiveLocationText("Road unit 3", "Fixture"));
  // All eleven committed migrations enforce NOT NULL locality: null-locality rows cannot be persisted.
  assert.throws(() => f.sql.exec("UPDATE resident_addresses SET locality=NULL"), /NOT NULL/);
});

test("account completion preserves GET-derived legacy location and rolls back a failed revision", async t => {
  const f = setup(t);
  const original = f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get();
  const { address: read } = await (await f.load(addressRoute).GET(new Request("https://example.test/api"))).json();
  const payload = { ...read, latitude: undefined, longitude: undefined, house: "Synthetic revised", role: "resident", name: "Synthetic renamed", termsAccepted: true };
  const save = () => f.load("app/api/account/complete/route.ts").POST(jsonRequest(payload, "POST"));
  f.db.beforeStatement = (index, statement) => { if (statement.query.startsWith("UPDATE resident_addresses")) throw Error("synthetic rollback"); };
  assert.equal((await save()).status, 500);
  assert.deepEqual(f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get(), original);
  f.db.beforeStatement = null;
  const result = await save();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).profileComplete, true);
  const current = f.sql.prepare("SELECT * FROM resident_addresses WHERE is_primary=1").get();
  assert.notEqual(current.id, original.id);
  assert.deepEqual([current.latitude_e6, current.longitude_e6], [10000000, 20000000]);
});

test("helper GET-derived outer whitespace survives unrelated profile edits without a legacy fallback", async t => {
  const f = setup(t); asHelper(f);
  f.sql.exec("UPDATE helper_profiles SET home_address='  Fixture  ',home_locality='  Fixture  '");
  const route = f.load("app/api/helper/profile/route.ts");
  const { profile } = await (await route.GET(new Request("https://example.test/api"))).json();
  assert.equal(profile.homeAddress, "Fixture");
  assert.equal((await route.PUT(jsonRequest({ ...profilePayload, homeAddress: profile.homeAddress, locality: profile.locality, yearsExperience: 3, latitude: undefined, longitude: undefined }))).status, 200);
  assert.deepEqual({ ...f.sql.prepare("SELECT latitude_e6,longitude_e6 FROM helper_profiles").get() }, { latitude_e6: 10000000, longitude_e6: 20000000 });
});

test("legacy preservation keeps booking history, rollback and ownership intact", async t => {
  const f = setup(t);
  seedRequest(f, { status: "accepted", booking: "active" });
  const original = f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get();
  const route = f.load(addressRoute);
  const { address: read } = await (await route.GET(new Request("https://example.test/api"))).json();
  const payload = { ...read, house: "Synthetic changed unit", latitude: undefined, longitude: undefined };
  f.db.beforeStatement = (index, statement) => { if (statement.query.startsWith("UPDATE resident_addresses")) throw Error("synthetic rollback"); };
  assert.equal((await route.PUT(jsonRequest(payload))).status, 500);
  assert.deepEqual(f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get(), original);
  f.db.beforeStatement = null;
  addResident(f); asResident(f, "other");
  assert.equal((await route.PUT(jsonRequest({ ...payload, id: "address", residentId: "resident" }))).status, 200);
  assert.deepEqual(f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get(), original);
  asResident(f);
  assert.equal((await route.PUT(jsonRequest(payload))).status, 200);
  assert.deepEqual({ ...f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'").get() }, { ...original, is_primary: 0 });
  assert.equal(f.sql.prepare("SELECT resident_address_id FROM booking_requests").get().resident_address_id, "address");
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});

test("legacy preservation reads the latest effective location inside the atomic revision", async t => {
  const f = setup(t);
  const route = f.load(addressRoute);
  const { address: read } = await (await route.GET(new Request("https://example.test/api"))).json();
  f.db.beforeBatch = async () => {
    assert.equal((await route.PUT(jsonRequest({ ...address, latitude: 11, longitude: 21 }))).status, 200);
  };
  assert.equal((await route.PUT(jsonRequest({ ...read, house: "Synthetic stale edit", latitude: undefined, longitude: undefined }))).status, 200);
  const current = f.sql.prepare("SELECT latitude_e6,longitude_e6 FROM resident_addresses WHERE is_primary=1").get();
  assert.deepEqual({ ...current }, { latitude_e6: null, longitude_e6: null });
  assert.equal(count(f, "resident_addresses"), 3);
});

const storedCoordinateCases = [
  ["min-int64 latitude", -9223372036854775808n, 20000000, false],
  ["min-int64 longitude", 10000000, -9223372036854775808n, false],
  ["max-int64 latitude", 9223372036854775807n, 20000000, false],
  ["max-int64 longitude", 10000000, 9223372036854775807n, false],
  ["latitude below", -90000001, 20000000, false],
  ["latitude lower boundary", -90000000, 20000000, true],
  ["latitude upper boundary", 90000000, 20000000, true],
  ["latitude above", 90000001, 20000000, false],
  ["longitude below", 10000000, -180000001, false],
  ["longitude lower boundary", 10000000, -180000000, true],
  ["longitude upper boundary", 10000000, 180000000, true],
  ["longitude above", 10000000, 180000001, false],
  ["zero latitude", 0, 20000000, true],
  ["zero longitude", 10000000, 0, true],
  ["text latitude", "malformed", 20000000, false],
  ["text longitude", 10000000, "malformed", false],
  ["real latitude", 10000000.5, 20000000, false],
  ["real longitude", 10000000, 20000000.5, false],
];
const rawAddress = f => {
  const statement = f.sql.prepare("SELECT * FROM resident_addresses WHERE id='address'");
  statement.setReadBigInts(true);
  return { ...statement.get() };
};
const pointOf = row => [row.latitude_e6, row.longitude_e6];
for (const [label, lat, lon, valid] of storedCoordinateCases) {
  test(`stored coordinate helper PUT/GET and matching: ${label}`, async t => {
    const f = setup(t);
    f.sql.prepare("UPDATE helper_profiles SET home_address='Fixture',latitude_e6=?,longitude_e6=?").run(lat, lon);
    const matches = await f.load(matchesRoute).POST(jsonRequest(wanted, "POST"));
    assert.equal(matches.status, 200);
    assert.equal((await matches.json()).matches.length, valid ? 1 : 0);
    asHelper(f);
    const route = f.load("app/api/helper/profile/route.ts");
    const read = await route.GET(new Request("https://example.test/api"));
    assert.equal(read.status, 200);
    const profile = (await read.json()).profile;
    assert.deepEqual([profile.latitude, profile.longitude], valid ? [Number(lat) / 1e6, Number(lon) / 1e6] : [null, null]);
    const payload = { ...profilePayload, latitude: undefined, longitude: undefined, yearsExperience: 3 };
    assert.equal((await route.PUT(jsonRequest(payload))).status, 200);
    const current = () => f.sql.prepare("SELECT latitude_e6,longitude_e6 FROM helper_profiles WHERE user_id='helper'").get();
    assert.deepEqual(pointOf(current()), valid ? [lat, lon] : [null, null]);
    assert.equal((await route.PUT(jsonRequest({ ...payload, homeAddress: "Different synthetic location" }))).status, 200);
    assert.deepEqual(pointOf(current()), [null, null]);
    assert.equal((await route.PUT(jsonRequest({ ...payload, latitude: 11, longitude: 21 }))).status, 200);
    assert.deepEqual(pointOf(current()), [11000000, 21000000]);
    assert.deepEqual(f.logs, []);
  });
  for (const account of [false, true]) {
    test(`stored coordinate resident ${account ? "account" : "address"} paths: ${label}`, async t => {
      const f = setup(t);
      f.sql.prepare("UPDATE resident_addresses SET latitude_e6=?,longitude_e6=? WHERE id='address'").run(lat, lon);
      if (valid) f.sql.prepare("UPDATE helper_profiles SET latitude_e6=?,longitude_e6=?").run(lat, lon);
      const original = rawAddress(f);
      const complete = () => f.load("app/lib/profile-completeness.ts").residentProfileComplete(f.db, "resident");
      assert.equal(await complete(), valid);
      const read = await f.load(addressRoute).GET(new Request("https://example.test/api"));
      assert.equal(read.status, 200);
      const { address: loaded } = await read.json();
      assert.deepEqual([loaded.latitude, loaded.longitude], valid ? [Number(lat) / 1e6, Number(lon) / 1e6] : [null, null]);
      const matches = await f.load(matchesRoute).POST(jsonRequest(wanted, "POST"));
      assert.equal(matches.status, valid ? 200 : 409);
      if (valid) assert.equal((await matches.json()).matches.length, 1);
      if (!valid) assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
      const payload = { ...loaded, house: "Synthetic new unit", latitude: undefined, longitude: undefined,
        role: "resident", name: "Synthetic resident", termsAccepted: true };
      const save = value => f.load(account ? "app/api/account/complete/route.ts" : addressRoute)[account ? "POST" : "PUT"](jsonRequest(value, account ? "POST" : "PUT"));
      const saved = await save(payload);
      assert.equal(saved.status, 200);
      if (account) assert.equal((await saved.json()).profileComplete, valid);
      const current = () => f.sql.prepare("SELECT id,latitude_e6,longitude_e6 FROM resident_addresses WHERE resident_user_id='resident' AND is_primary=1").get();
      assert.deepEqual(pointOf(current()), valid ? [lat, lon] : [null, null]);
      assert.equal(await complete(), valid);
      assert.deepEqual(rawAddress(f), { ...original, is_primary: 0n });
      if (valid) {
        assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 200);
        assert.equal(f.sql.prepare("SELECT resident_address_id FROM booking_requests").get().resident_address_id, current().id);
      }
      assert.equal((await save({ ...payload, formattedAddress: "Different synthetic location" })).status, 200);
      assert.deepEqual(pointOf(current()), [null, null]);
      assert.equal((await save({ ...payload, latitude: 11, longitude: 21 })).status, 200);
      assert.deepEqual(pointOf(current()), [11000000, 21000000]);
      assert.deepEqual(rawAddress(f), { ...original, is_primary: 0n });
      assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    });
  }
  if (!valid) test(`atomic admission rejects newly malformed resident coordinates: ${label}`, async t => {
    const f = setup(t);
    onMutation(f, () => f.sql.prepare("UPDATE resident_addresses SET latitude_e6=?,longitude_e6=? WHERE id='address'").run(lat, lon));
    assert.equal((await f.load(requestRoute).POST(jsonRequest(wanted, "POST"))).status, 409);
    assert.equal(count(f, "booking_requests"), 0);
    assert.equal(count(f, "slot_claims"), 0);
  });
}

test("min-int64 repair preserves rollback, historical references and ownership", async t => {
  const f = setup(t);
  f.sql.exec("UPDATE resident_addresses SET latitude_e6=-9223372036854775808 WHERE id='address'");
  seedRequest(f, { status: "accepted", booking: "active" });
  const original = rawAddress(f);
  const payload = { ...address, formattedAddress: "Fixture", locality: "Fixture", latitude: undefined, longitude: undefined };
  const route = f.load(addressRoute);
  f.db.beforeStatement = (index, statement) => { if (statement.query.startsWith("UPDATE resident_addresses")) throw Error("synthetic failure"); };
  assert.equal((await route.PUT(jsonRequest(payload))).status, 500); // Injected failure, not coordinate overflow.
  assert.deepEqual(rawAddress(f), original);
  f.db.beforeStatement = null;
  addResident(f); asResident(f, "other");
  assert.equal((await route.PUT(jsonRequest({ ...payload, id: "address", residentId: "resident" }))).status, 200);
  assert.deepEqual(rawAddress(f), original);
  asResident(f);
  assert.equal((await route.PUT(jsonRequest(payload))).status, 200);
  assert.deepEqual(rawAddress(f), { ...original, is_primary: 0n });
  assert.equal(f.sql.prepare("SELECT resident_address_id FROM booking_requests").get().resident_address_id, "address");
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});

test("runtime stored-coordinate SQL never validates with overflow-prone abs", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  function scan(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${item.name}`;
      if (item.isDirectory()) scan(file);
      else if (/\.(?:[cm]?[jt]sx?|sql)$/.test(file)) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /\babs\s*\([^)]*\b(?:latitude_e6|longitude_e6)\b[^)]*\)/i, file);
      }
    }
  }
  scan("app"); scan("worker");
});


// Acceptance races run the real creation and response handlers with all migrations.
function acceptanceSnapshot(f) {
  const tables = ["booking_requests", "request_slots", "slot_claims", "bookings",
    "booking_slots", "booking_status_history", "workflow_transitions", "service_visits",
    "trial_payments", "analytics_events", "notification_log"];
  return JSON.stringify(tables.map(table => f.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}
async function createAcceptanceRequest(f) {
  const response = await f.load(requestRoute).POST(jsonRequest(wanted, "POST"));
  assert.equal(response.status, 200);
  const { requestId } = await response.json();
  assert.equal(count(f, "slot_claims"), 270);
  asHelper(f);
  return requestId;
}
const acceptanceCases = [
  ...["blocked", "deleted", "inactive", "paused", "unknown"].map(status => ({
    label: `user-${status}`,
    change: f => f.sql.prepare("UPDATE users SET status=? WHERE id='helper'").run(status),
    restore: f => f.sql.exec("UPDATE users SET status='active' WHERE id='helper'"),
  })),
  ...["draft", "review", "paused", "blocked", "inactive", "moderated", "unknown"].map(status => ({
    label: `profile-${status}`,
    change: f => f.sql.prepare("UPDATE helper_profiles SET profile_status=? WHERE user_id='helper'").run(status),
    restore: f => f.sql.exec("UPDATE helper_profiles SET profile_status='active' WHERE user_id='helper'"),
  })),
  {
    label: "missing-profile",
    change: f => f.sql.exec("DELETE FROM helper_profiles WHERE user_id='helper'"),
    restore: f => f.sql.exec("INSERT INTO helper_profiles(user_id,home_locality,profile_status) VALUES ('helper','Synthetic','active')"),
  },
  {
    label: "reassigned-request",
    change: (f, id) => {
      f.sql.exec("INSERT INTO users(id,name,mobile_e164) VALUES ('replacement','Synthetic replacement','synthetic-replacement')");
      f.sql.prepare("UPDATE booking_requests SET helper_user_id='replacement' WHERE id=?").run(id);
    },
    restore: (f, id) => f.sql.prepare("UPDATE booking_requests SET helper_user_id='helper' WHERE id=?").run(id),
  },
  {
    label: "deadline-crossed",
    change: f => { f.clock.now = "2030-01-08T10:00:00.000Z"; },
  },
  ...["trial", "active", "ending"].map(status => ({
    label: `resident-${status}`,
    change: f => seedRequest(f, { id: "competing", status: "accepted", booking: status }),
    restore: f => f.sql.exec("UPDATE bookings SET status='completed' WHERE id='booking-competing'"),
  })),
];
for (const scenario of acceptanceCases) {
  for (const recovery of ["withdraw", "retry"]) {
    test(`acceptance eligibility race ${scenario.label}: ${recovery}`, async t => {
      const f = setup(t);
      const requestId = await createAcceptanceRequest(f);
      let before, requestBefore;
      f.db.beforeBatch = function hook(statements) {
        if (!statements.some(s => /INSERT INTO bookings/.test(s.query))) { f.db.beforeBatch = hook; return; }
        scenario.change(f, requestId);
        before = acceptanceSnapshot(f);
        requestBefore = f.sql.prepare("SELECT * FROM booking_requests WHERE id=?").get(requestId);
      };
      // Client-supplied helper IDs cannot authorize the assigned helper.
      const accept = () => f.load(helperRequests).POST(jsonRequest({ requestId, decision: "accept", helperId: "resident" }, "POST"));
      const response = await accept();
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "This request is no longer awaiting a response." });
      assert.equal(typeof before, "string");
      assert.equal(acceptanceSnapshot(f) === before, true, "failed batch must leave every mutation table unchanged");
      assert.equal(JSON.stringify(f.sql.prepare("SELECT * FROM booking_requests WHERE id=?").get(requestId)) === JSON.stringify(requestBefore), true);
      assert.equal(f.sql.prepare("SELECT count(*) AS n FROM bookings WHERE request_id=?").get(requestId).n, 0);
      for (const table of ["booking_status_history", "booking_slots", "service_visits", "trial_payments"]) assert.equal(count(f, table), 0);
      assert.equal(f.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE booking_id IS NOT NULL").get().n, 0);
      assert.equal(f.logs.length, 0);
      if (recovery === "withdraw") {
        asResident(f);
        assert.equal((await f.load(requestRoute).DELETE(jsonRequest({ requestId }, "DELETE"))).status, 200);
        assert.equal(f.sql.prepare("SELECT status FROM booking_requests WHERE id=?").get(requestId).status, "withdrawn");
        assert.equal(count(f, "slot_claims"), 0);
      } else if (scenario.restore) {
        scenario.restore(f, requestId);
        assert.equal((await accept()).status, 200);
        assert.equal((await accept()).status, 409);
        assert.equal(f.sql.prepare("SELECT count(*) AS n FROM bookings WHERE request_id=?").get(requestId).n, 1);
        assert.equal(count(f, "booking_status_history"), 1);
        assert.equal(count(f, "service_visits"), 2);
        assert.equal(f.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE booking_id IS NOT NULL").get().n, 270);
      } else {
        assert.equal((await accept()).status, 409);
        assert.equal(f.sql.prepare("SELECT status FROM booking_requests WHERE id=?").get(requestId).status, "expired");
        assert.equal(count(f, "slot_claims"), 0);
      }
      assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    });
  }
}
test("acceptance eligible control commits once and returns contact only after commit", async t => {
  const f = setup(t), requestId = await createAcceptanceRequest(f);
  const response = await f.load(helperRequests).POST(jsonRequest({ requestId, decision: "accept" }, "POST"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Boolean(body.request.residentMobile && body.request.residentAddress), true);
  assert.equal(count(f, "bookings"), 1);
  assert.equal(count(f, "booking_status_history"), 1);
  assert.equal(count(f, "booking_slots"), 6);
  assert.equal(count(f, "service_visits"), 2);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE booking_id IS NOT NULL").get().n, 270);
});
test("acceptance missing user is forbidden by committed foreign keys", async t => {
  const f = setup(t), requestId = await createAcceptanceRequest(f);
  f.db.beforeBatch = function hook(statements) {
    if (!statements.some(s => /INSERT INTO bookings/.test(s.query))) { f.db.beforeBatch = hook; return; }
    assert.throws(() => f.sql.exec("DELETE FROM users WHERE id='helper'"), /FOREIGN KEY constraint failed/);
  };
  assert.equal((await f.load(helperRequests).POST(jsonRequest({ requestId, decision: "accept" }, "POST"))).status, 200);
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});
for (const failure of ["INSERT INTO booking_status_history", "INSERT INTO service_visits"]) {
  test(`acceptance rollback after eligibility guard: ${failure}`, async t => {
    const f = setup(t), requestId = await createAcceptanceRequest(f), before = acceptanceSnapshot(f);
    let reached = false;
    f.db.beforeStatement = (_index, statement) => {
      if (statement.query.includes(failure)) { reached = true; throw Error("synthetic late mutation failure"); }
    };
    const accept = () => f.load(helperRequests).POST(jsonRequest({ requestId, decision: "accept" }, "POST"));
    const response = await accept();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "We could not save your response. Please try again." });
    assert.equal(reached, true);
    assert.equal(acceptanceSnapshot(f) === before, true);
    assert.equal(f.logs.length, 0);
    f.db.beforeStatement = null;
    assert.equal((await accept()).status, 200);
    assert.equal((await accept()).status, 409);
    assert.equal(count(f, "bookings"), 1);
  });
}

for (const change of [
  "UPDATE users SET status='blocked' WHERE id='helper'",
  "UPDATE helper_profiles SET profile_status='paused' WHERE user_id='helper'",
]) {
  test("acceptance post-commit authorization hides contact after a subsequent eligibility change", async t => {
    const f = setup(t), requestId = await createAcceptanceRequest(f);
    const batch = f.db.batch.bind(f.db);
    f.db.batch = async statements => {
      const result = await batch(statements);
      if (statements.some(s => /INSERT INTO bookings/.test(s.query))) f.sql.exec(change);
      return result;
    };
    const response = await f.load(helperRequests).POST(jsonRequest({ requestId, decision: "accept" }, "POST"));
    assert.equal(response.status, 200); // The acceptance committed before the independent change.
    assert.equal((await response.json()).request, null);
    assert.equal(count(f, "bookings"), 1);
    assert.equal(f.logs.length, 0);
  });
}
test("acceptance eligibility does not prevent an assigned paused helper declining", async t => {
  const f = setup(t), requestId = await createAcceptanceRequest(f);
  f.sql.exec("UPDATE helper_profiles SET profile_status='paused' WHERE user_id='helper'");
  const response = await f.load(helperRequests).POST(jsonRequest({ requestId, decision: "decline" }, "POST"));
  assert.equal(response.status, 200);
  assert.equal(count(f, "bookings"), 0);
  assert.equal(count(f, "slot_claims"), 0);
});
