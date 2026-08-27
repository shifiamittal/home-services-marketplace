import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixture, jsonRequest, profilePayload, referenceSlot } from "./helpers/local-routes.mjs";
import { residentDestination, residentManagement, residentLoadDisposition, avatarInitial } from "../app/lib/resident-navigation.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const helperRoute = "app/api/helper/profile/route.ts";

// Minimal historical delete-and-reinsert strategy, exercised against the real
// checked-in schema. It must fail because of a reference, not a missing source.
function legacyReplaceAvailability(db) {
  return db.batch([
    db.prepare("DELETE FROM availability_slots WHERE helper_user_id = ? AND status IN ('open', 'inactive')").bind("helper"),
    db.prepare("INSERT INTO availability_slots (id, helper_user_id, day_of_week, start_minute, end_minute, status) VALUES (?, ?, 1, 480, 720, 'open')")
      .bind("replacement", "helper"),
  ]);
}

function assertIssueForm(source, view, categories, selection, feedback, destination) {
  const form = source.split("\n").find(line => line.includes(`{view === "${view}"`));
  assert.ok(form, `Missing ${view} form`);
  const options = form.match(/className="issue-options">\{(\[[^\]]+\])\.map/);
  assert.ok(options, "Issue categories must be rendered");
  assert.deepEqual(JSON.parse(options[1]), categories);
  assert.ok(form.includes(`checked={${selection} === item}`));
  assert.ok(form.includes(`value={${feedback}}`));
  assert.match(form, /maxLength=\{1000\}/);
  assert.ok(form.includes(`disabled={!${selection} || issueBusy}`));
  assert.match(form, /onClick=\{\(\) => void submitIssue\(\)\}/);
  assert.match(form, /issueCaseNumber/);
  assert.ok(form.includes(`navTo("${destination}")`));
}

test("schema reproduction: legacy destructive save fails with referenced slots; current save preserves IDs and snapshots", async () => {
  const unreferenced = fixture();
  try {
    await legacyReplaceAvailability(unreferenced.db);
    await legacyReplaceAvailability(unreferenced.db);
    assert.equal(unreferenced.sql.prepare("SELECT id FROM availability_slots").get().id, "replacement");
  } finally { unreferenced.sql.close(); }
  const f = fixture();
  try {
    referenceSlot(f, "accepted", "active");
    const before = f.sql.prepare("SELECT * FROM request_slots").all();
    const bookingBefore = f.sql.prepare("SELECT * FROM booking_slots").all();
    await assert.rejects(legacyReplaceAvailability(f.db), /FOREIGN KEY constraint failed/);
    assert.equal((await f.load(helperRoute).PUT(jsonRequest(profilePayload))).status, 200);
    assert.deepEqual(f.sql.prepare("SELECT * FROM request_slots").all(), before);
    assert.deepEqual(f.sql.prepare("SELECT * FROM booking_slots").all(), bookingBefore);
    assert.equal(f.sql.prepare("SELECT status FROM availability_slots WHERE id='old'").get().status, "open");
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    const ids = f.sql.prepare("SELECT id FROM availability_slots ORDER BY id").all();
    assert.equal((await f.load(helperRoute).PUT(jsonRequest(profilePayload))).status, 200);
    assert.deepEqual(f.sql.prepare("SELECT id FROM availability_slots ORDER BY id").all(), ids);
  } finally { f.sql.close(); }
});

test("historical referenced windows retire without deletion, and retired windows are excluded from matching", async () => {
  const f = fixture();
  try {
    referenceSlot(f, "withdrawn", "cancelled");
    const body = { ...profilePayload, availability: [{ days: "mon_sat", start: "14:00", end: "17:00" }] };
    assert.equal((await f.load(helperRoute).PUT(jsonRequest(body))).status, 200);
    assert.equal(f.sql.prepare("SELECT status FROM availability_slots WHERE id='old'").get().status, "inactive");
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM booking_slots WHERE availability_slot_id='old'").get().n, 1);
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    assert.match(readFileSync("app/api/resident/matches/route.ts", "utf8"), /status = 'open'/);
  } finally { f.sql.close(); }
});

for (const [requestStatus, bookingStatus] of [["pending", undefined], ["accepted", "trial"], ["accepted", "active"], ["accepted", "ending"]]) {
  test("cannot exclude commitment: " + (bookingStatus || requestStatus), async () => {
    const f = fixture();
    try {
      referenceSlot(f, requestStatus, bookingStatus);
      const before = f.sql.prepare("SELECT * FROM availability_slots").all();
      const result = await f.load(helperRoute).PUT(jsonRequest({ ...profilePayload, availability: [{ days: "mon_sat", start: "14:00", end: "17:00" }] }));
      assert.equal(result.status, 409);
      assert.ok((await result.json()).fields.availability);
      assert.deepEqual(f.sql.prepare("SELECT * FROM availability_slots").all(), before);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM helper_offerings").get().n, 0);
    } finally { f.sql.close(); }
  });
}

test("a pending hold inserted after profile pre-read is protected inside the save transaction", async () => {
  const f = fixture();
  try {
    f.db.beforeBatch = () => referenceSlot(f, "pending");
    const result = await f.load(helperRoute).PUT(jsonRequest({ ...profilePayload, availability: [{ days: "mon_sat", start: "14:00", end: "17:00" }] }));
    assert.equal(result.status, 409);
    assert.equal(f.sql.prepare("SELECT status FROM availability_slots WHERE id='old'").get().status, "open");
  } finally { f.sql.close(); }
});

for (const status of ["paused", "blocked", "review"]) {
  test("profile saves preserve " + status + " moderation state", async () => {
    const f = fixture();
    try {
      f.sql.prepare("UPDATE helper_profiles SET profile_status=?").run(status);
      assert.equal((await f.load(helperRoute).PUT(jsonRequest(profilePayload))).status, 200);
      assert.equal(f.sql.prepare("SELECT profile_status FROM helper_profiles").get().profile_status, status);
    } finally { f.sql.close(); }
  });
}

test("profile validation is field-specific; unexpected failures expose only an opaque correlation ID", async () => {
  const f = fixture();
  try {
    const route = f.load(helperRoute);
    const invalid = await route.PUT(jsonRequest({ ...profilePayload, latitude: null }));
    assert.equal(invalid.status, 400);
    assert.ok((await invalid.json()).fields.address);
    f.db.beforeBatch = () => { throw new Error("SENTINEL_PRIVATE"); };
    const failed = await route.PUT(jsonRequest(profilePayload));
    assert.equal(failed.status, 500);
    const body = await failed.json();
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body) + f.logs.join(""), /SENTINEL_PRIVATE|Fixture|latitude/);
  } finally { f.sql.close(); }
});

test("resident completeness gates session, matching and request routes with the same committed data", async () => {
  const f = fixture();
  f.session.user_id = "resident"; f.session.role = "resident"; f.session.roles = ["resident"];
  try {
    const session = f.load("app/api/auth/session/route.ts");
    const request = () => new Request("https://example.test/api");
    assert.equal((await (await session.GET(request())).json()).profileComplete, true);
    const mutations = ["UPDATE users SET name='   ' WHERE id='resident'", "DELETE FROM resident_profiles", "UPDATE resident_addresses SET is_primary=0"];
    for (const mutation of mutations) {
      f.sql.exec("SAVEPOINT missing");
      f.sql.exec(mutation);
      assert.equal((await (await session.GET(request())).json()).profileComplete, false);
      for (const route of ["app/api/resident/matches/route.ts", "app/api/resident/requests/route.ts"]) {
        const result = await f.load(route).POST(jsonRequest({}, "POST"));
        assert.equal(result.status, 409);
        assert.equal((await result.json()).code, "PROFILE_INCOMPLETE");
      }
      f.sql.exec("ROLLBACK TO missing; RELEASE missing");
    }
    assert.equal(residentDestination(false, "dashboard"), "residentAccount");
    assert.equal(residentDestination(false, "requirement"), "residentAccount");
    assert.equal(residentDestination(true, "membership"), "dashboard");
    assert.equal(avatarInitial("  Synthetic resident  "), "S");
  } finally { f.sql.close(); }
});

test("late booking loads retain authorized state, and proof retry retains only an in-memory File", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  assert.doesNotMatch(source, /if \(!residentCompleteRef.current\) \{ setView\("residentAccount"\); return null; \}/);
  assert.match(source, /residentLoadDisposition\(load, residentLoadRef.current, navigation, residentNavigationRef.current\)/);
  assert.doesNotMatch(source, /uploadId/);
  assert.match(source, /form.append\("file", retry.file\)/);
  assert.match(source, /Retry selected address proof/);
  assert.doesNotMatch(source, /view === "membership"|setPaymentOpen/);
  assert.match(source, /No bookings scheduled/);
  assert.match(source, /Helper dashboard/);
});

test("new helper and declined-request saves use the existing schema without destroying history", async () => {
  const f = fixture();
  try {
    f.sql.exec("DELETE FROM helper_profiles");
    assert.equal((await f.load(helperRoute).PUT(jsonRequest(profilePayload))).status, 200);
    f.sql.exec("DELETE FROM availability_slots");
    referenceSlot(f, "declined");
    assert.equal((await f.load(helperRoute).PUT(jsonRequest(profilePayload))).status, 200);
    assert.equal(f.sql.prepare("SELECT status FROM booking_requests").get().status, "declined");
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.sql.close(); }
});

test("a nonconflicting expanded window preserves pending commitment snapshots", async () => {
  const f = fixture();
  try {
    referenceSlot(f, "pending");
    const snapshot = f.sql.prepare("SELECT * FROM request_slots").all();
    assert.equal((await f.load(helperRoute).PUT(jsonRequest({ ...profilePayload, availability: [{ days: "mon_sat", start: "07:00", end: "12:00" }] }))).status, 200);
    assert.deepEqual(f.sql.prepare("SELECT * FROM request_slots").all(), snapshot);
    assert.equal(f.sql.prepare("SELECT status FROM availability_slots WHERE id='old'").get().status, "inactive");
  } finally { f.sql.close(); }
});

test("request creation rejects a window retired between the pre-read and transaction", async () => {
  const f = fixture();
  try {
    assert.equal((await f.load(helperRoute).PUT(jsonRequest(profilePayload))).status, 200);
    f.session.user_id = "resident"; f.session.role = "resident"; f.session.roles = ["resident"];
    const original = f.db.batch.bind(f.db);
    let raced = false;
    f.db.batch = async statements => {
      if (statements[0]?.query.includes("stale_availability")) {
        raced = true;
        f.sql.exec("UPDATE availability_slots SET status='inactive'");
      }
      return original(statements);
    };
    const result = await f.load("app/api/resident/requests/route.ts").POST(jsonRequest({
      helperId: "helper", service: "utensils_once", homeSize: "one_two_bhk",
      firstTime: "09:00", requestedStartDate: "2099-01-01",
    }, "POST"));
    assert.equal(raced, true);
    assert.equal(result.status, 409);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM booking_requests").get().n, 0);
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.sql.close(); }
});

test("resident completion survives a failed validation, then refresh/re-login reads the saved canonical name", async () => {
  const f = fixture();
  try {
    f.session.user_id = "resident"; f.session.role = "resident"; f.session.roles = ["resident"];
    f.sql.exec("DELETE FROM resident_profiles; UPDATE users SET name='' WHERE id='resident'");
    const complete = f.load("app/api/account/complete/route.ts").POST;
    const body = { role: "resident", name: "  Synthetic saved  ", house: "Fixture", locality: "Fixture", formattedAddress: "Fixture", latitude: 0, longitude: 0, termsAccepted: true };
    assert.equal((await complete(jsonRequest({ ...body, latitude: null }, "POST"))).status, 400);
    assert.equal(f.sql.prepare("SELECT name FROM users WHERE id='resident'").get().name, "");
    assert.equal((await complete(jsonRequest(body, "POST"))).status, 200);
    assert.equal(f.sql.prepare("SELECT name FROM users WHERE id='resident'").get().name, "Synthetic saved");
    assert.equal((await complete(jsonRequest(body, "POST"))).status, 200);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM resident_profiles WHERE user_id='resident'").get().n, 1);
    const session = await f.load("app/api/auth/session/route.ts").GET(new Request("https://example.test/api"));
    assert.equal((await session.json()).profileComplete, true);
    const otp = readFileSync("app/api/auth/msg91/complete/route.ts", "utf8");
    assert.match(otp, /await residentProfileComplete\(db, user.id\)/);
    let completeNow = true;
    let resolve;
    const delayed = new Promise(done => { resolve = done; }).then(() => residentDestination(completeNow, "dashboard"));
    completeNow = false;
    resolve();
    assert.equal(await delayed, "residentAccount");
    assert.equal(residentDestination(true, "requirement"), "requirement");
  } finally { f.sql.close(); }
});

test("helper navigation renders all destinations with exactly one active tab, without changing issue form", () => {
  const f = fixture();
  try {
    const { HelperNavigation } = f.load("app/components/helper-navigation.tsx");
    for (const view of ["providerDashboard", "incoming", "helperSchedule", "helperNotifications", "providerSettings", "setup", "providerIssue"]) {
      const html = renderToStaticMarkup(createElement(HelperNavigation, { view, onNavigate() {} }));
      for (const label of ["Home", "Requests", "Schedule", "Notifications", "Profile"]) assert.ok(html.includes(">" + label + "</button>"));
      assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    }
    const current = readFileSync("app/page.tsx", "utf8").split("\n");
    assertIssueForm(current.join("\n"), "providerIssue",
      ["Resident was unavailable", "Work requested was different", "Payment is overdue", "Safety or misconduct", "I need to end this job", "Something else"],
      "providerIssue", "providerIssueFeedback", "providerDashboard");
    assert.ok(current.some(line => line.includes("Help &amp; support") && line.includes("onClick={openIssueReport}")));
  } finally { f.sql.close(); }
});

function incompleteResident(f) {
  f.session.user_id = "resident"; f.session.role = "resident"; f.session.roles = ["resident"];
  f.sql.exec("DELETE FROM resident_profiles");
}
async function residentState(f) {
  const response = await f.load("app/api/resident/requests/route.ts").GET(new Request("https://example.test/api"));
  assert.equal(response.status, 200);
  return response.json();
}

for (const [status, expected] of [[null, "residentAccount"], ["pending", "pending"], ["active", "dashboard"], ["trial", "confirmed"], ["ending", "dashboard"]]) {
  test("incomplete resident retains authorized " + (status || "empty") + " lifecycle", async () => {
    const f = fixture();
    try {
      incompleteResident(f);
      if (status) referenceSlot(f, status === "pending" ? "pending" : "accepted", status === "pending" ? undefined : status);
      const state = await residentState(f);
      const management = residentManagement(state.request, state.paymentPending);
      assert.equal(management.destination, expected);
      assert.equal(residentDestination(false, expected, management), expected);
      for (const destination of ["matches", "profile", "review", "address"]) assert.equal(residentDestination(false, destination, management), "residentAccount");
      for (const route of ["app/api/resident/matches/route.ts", "app/api/resident/requests/route.ts"]) {
        assert.equal((await f.load(route).POST(jsonRequest({}, "POST"))).status, 409);
      }
      if (status && status !== "pending") {
        assert.equal(state.request.bookingId, "booking");
        assert.equal(residentDestination(false, "issue", management), "issue");
        assert.equal((await f.load("app/api/issues/route.ts").POST(jsonRequest({ bookingId: "booking", category: "Something else" }, "POST"))).status, 200);
      }
      for (const destination of ["dashboard", "requirement", "pending", "confirmed", "issue"]) {
        assert.equal(residentDestination(true, destination, management), destination);
      }
    } finally { f.sql.close(); }
  });
}

test("incomplete resident can cancel trial and withdraw pending request without changing profile/address", async () => {
  for (const trial of [false, true]) {
    const f = fixture();
    try {
      incompleteResident(f);
      referenceSlot(f, trial ? "accepted" : "pending", trial ? "trial" : undefined);
      const addresses = f.sql.prepare("SELECT * FROM resident_addresses").all();
      const response = trial
        ? await f.load("app/api/bookings/cancel/route.ts").POST(jsonRequest({ bookingId: "booking", reason: "Something else" }, "POST"))
        : await f.load("app/api/resident/requests/route.ts").DELETE(jsonRequest({ requestId: "request" }, "DELETE"));
      assert.equal(response.status, 200);
      const state = await residentState(f);
      assert.equal(residentManagement(state.request, state.paymentPending).destination, "residentAccount");
      assert.deepEqual(f.sql.prepare("SELECT * FROM resident_addresses").all(), addresses);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM resident_profiles").get().n, 0);
    } finally { f.sql.close(); }
  }
});

test("incomplete resident payment due and resolution remain accessible; resolved state returns to onboarding", async () => {
  const f = fixture();
  try {
    incompleteResident(f); referenceSlot(f, "accepted", "cancelled");
    f.sql.exec("INSERT INTO trial_payments(id,booking_id,resident_user_id,helper_user_id,amount_paise) VALUES ('payment','booking','resident','helper',1000)");
    for (const status of ["pending", "resident_marked_paid", "review_requested"]) {
      f.sql.prepare("UPDATE trial_payments SET status=?").run(status);
      const state = await residentState(f);
      const management = residentManagement(state.request, state.paymentPending);
      assert.equal(management.destination, "requirement");
      assert.equal(residentDestination(false, "requirement", management), "requirement");
      assert.equal(residentDestination(false, "issue", management), "issue");
    }
    f.sql.exec("UPDATE trial_payments SET status='pending'");
    assert.equal((await f.load("app/api/bookings/payment/route.ts").POST(jsonRequest({ paymentId: "payment", action: "mark_paid" }, "POST"))).status, 200);
    f.sql.exec("UPDATE trial_payments SET resident_marked_paid_at=datetime('now','-13 hours')");
    assert.equal((await f.load("app/api/bookings/payment/route.ts").POST(jsonRequest({ paymentId: "payment", action: "request_review" }, "POST"))).status, 200);
    f.sql.exec("UPDATE trial_payments SET status='confirmed'");
    const state = await residentState(f);
    assert.equal(residentManagement(state.request, state.paymentPending).destination, "residentAccount");
  } finally { f.sql.close(); }
});

test("another resident cannot read or mutate linked booking, issue, payment, or request", async () => {
  const f = fixture();
  try {
    referenceSlot(f, "accepted", "trial");
    f.sql.exec("INSERT INTO users(id,name,mobile_e164) VALUES ('other','Synthetic other','+10000000002'); INSERT INTO trial_payments(id,booking_id,resident_user_id,helper_user_id,amount_paise) VALUES ('payment','booking','resident','helper',1000)");
    f.session.user_id = "other"; f.session.role = "resident"; f.session.roles = ["resident"];
    const state = await residentState(f);
    assert.equal(state.request, null); assert.equal(state.paymentPending, null);
    for (const [route, body, code] of [
      ["app/api/issues/route.ts", { bookingId: "booking", category: "Something else" }, 404],
      ["app/api/bookings/cancel/route.ts", { bookingId: "booking", reason: "Something else" }, 404],
      ["app/api/bookings/payment/route.ts", { paymentId: "payment", action: "mark_paid" }, 403],
    ]) assert.equal((await f.load(route).POST(jsonRequest(body, "POST"))).status, code);
    f.sql.exec("UPDATE booking_requests SET status='pending'");
    assert.equal((await f.load("app/api/resident/requests/route.ts").DELETE(jsonRequest({ requestId: "request" }, "DELETE"))).status, 409);
    assert.equal(f.sql.prepare("SELECT status FROM booking_requests WHERE id='request'").get().status, "pending");
  } finally { f.sql.close(); }
});

test("late client loads neither erase a newer commitment nor replace a chosen linked issue destination", async () => {
  let latest = 1, navigation = 0, view = "dashboard";
  let release;
  const delayed = new Promise(resolve => { release = resolve; }).then(() => {
    const disposition = residentLoadDisposition(1, latest, 0, navigation);
    if (disposition.navigate) view = "residentAccount";
    return disposition;
  });
  navigation++; view = "issue"; release();
  assert.deepEqual(await delayed, { accept: true, navigate: false });
  assert.equal(view, "issue");
  latest++;
  assert.deepEqual(residentLoadDisposition(1, latest, 0, navigation), { accept: false, navigate: false });
  assert.deepEqual(residentLoadDisposition(2, latest, navigation, navigation), { accept: true, navigate: true });
  const source = readFileSync("app/page.tsx", "utf8");
  assert.match(source, /if \(!disposition.accept\) return residentStateRef.current.request/);
  assert.match(source, /residentStateRef.current = \{ request: saved, payment: result.paymentPending/);
  assert.match(source, /residentProfileReady \? <><Field label="What services/);
  assertIssueForm(source, "issue",
    ["Helper did not arrive", "Timing did not work", "Not satisfied with service", "Safety or misconduct", "Something else"],
    "residentIssue", "residentIssueFeedback", "dashboard");
});

test("actual resident loader retains incomplete booking/payment state and ignores stale navigation/results", async () => {
  const f = fixture();
  try {
    const source = readFileSync("app/page.tsx", "utf8");
    const loader = source.slice(source.indexOf("  async function loadResidentRequest("), source.indexOf("  async function loadHelperRequests("));
    const build = f.load("app/page.tsx", `
      import { residentManagement, residentDestination, residentLoadDisposition } from "./lib/resident-navigation";
      export function bind(context) {
        const { fetch, residentLoadRef, residentNavigationRef, residentCompleteRef, residentStateRef,
          setCurrentRequest, setTrialPayment, setBooking, setView, setRequestError, setMatchesError, view } = context;
        const providerMessage = () => "Load failed";
        ${loader}
        return loadResidentRequest;
      }
    `).bind;
    const writes = { request: null, payment: null, view: "dashboard" };
    const waiting = [];
    const context = {
      fetch: () => new Promise(resolve => waiting.push(body => resolve({ ok: true, json: async () => body }))),
      residentLoadRef: { current: 0 }, residentNavigationRef: { current: 0 },
      residentCompleteRef: { current: false }, residentStateRef: { current: { request: null, payment: null } },
      view: "dashboard", setCurrentRequest: value => { writes.request = value; },
      setTrialPayment: value => { writes.payment = value; }, setBooking() {},
      setView: value => { writes.view = value; }, setRequestError: assert.fail, setMatchesError() {},
    };
    const load = build(context);
    const active = { id: "request", status: "accepted", bookingId: "booking", bookingStatus: "active" };
    const first = load();
    waiting.shift()({ request: active, workflowState: "booking_active" });
    await first;
    assert.equal(writes.request, active); assert.equal(writes.view, "dashboard");
    const late = load();
    context.residentNavigationRef.current++; writes.view = "issue";
    waiting.shift()({ request: active, workflowState: "booking_active" });
    await late;
    assert.equal(writes.view, "issue"); assert.equal(writes.request, active);
    const obsolete = load();
    const latest = load();
    const payment = { id: "payment", status: "pending" };
    waiting[1]({ request: active, paymentPending: payment, workflowState: "trial_payment_due" });
    await latest;
    waiting[0]({ request: null, workflowState: "ready_to_search" });
    await obsolete;
    assert.equal(writes.payment, payment);
    assert.equal(writes.request, active);
    assert.equal(writes.view, "requirement");
    assert.equal(context.residentStateRef.current.payment, payment);
  } finally { f.sql.close(); }
});
