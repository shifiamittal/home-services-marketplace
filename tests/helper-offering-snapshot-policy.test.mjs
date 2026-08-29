import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonRequest } from "./helpers/local-routes.mjs";

const profileRoute = "app/api/helper/profile/route.ts";
const residentRoute = "app/api/resident/requests/route.ts";
const helperRequestsRoute = "app/api/helper/requests/route.ts";
const once = price => ({ houseCleaning: [], utensils: { frequency: "once", onceDailyMonthlyPricePaise: price } });
const houseOnly = { houseCleaning: [{ homeSize: "one_two_bhk", monthlyPricePaise: 70_000 }], utensils: null };

function asResident(f, id = "resident") {
  f.session.user_id = id; f.session.role = "resident"; f.session.roles = ["resident"]; f.session.name = `Resident ${id}`;
}
function asHelper(f) {
  f.session.user_id = "helper"; f.session.role = "provider"; f.session.roles = ["provider"]; f.session.name = "Synthetic helper";
}
function addResident(f, id) {
  const suffix = id.endsWith("3") ? "3" : "2";
  f.sql.exec(`INSERT INTO users(id,name,mobile_e164) VALUES ('${id}','Resident ${id}','+1000000000${suffix}');
    INSERT INTO user_roles(user_id,role) VALUES ('${id}','resident');
    INSERT INTO resident_profiles(user_id) VALUES ('${id}');
    INSERT INTO resident_addresses(id,resident_user_id,house_or_flat,locality,latitude_e6,longitude_e6,is_primary)
      VALUES ('address-${id}','${id}','Fixture','Fixture',10000000,20000000,1)`);
}
function seedOfferingAndSchedule(f) {
  f.sql.exec(`UPDATE helper_profiles SET latitude_e6=10000001,longitude_e6=20000001 WHERE user_id='helper';
    INSERT INTO helper_offerings(id,helper_user_id,service_type,home_size,monthly_price_paise,is_active)
      VALUES ('offering','helper','utensils_once','not_applicable',50000,1);
    INSERT INTO availability_slots(id,helper_user_id,day_of_week,start_minute,end_minute,status) VALUES
      ('mon','helper',1,480,720,'open'),('tue','helper',2,480,720,'open'),('wed','helper',3,480,720,'open'),
      ('thu','helper',4,480,720,'open'),('fri','helper',5,480,720,'open'),('sat','helper',6,480,720,'open')`);
}
async function requestOnce(f, residentId, firstTime = "09:00") {
  asResident(f, residentId);
  return f.load(residentRoute).POST(jsonRequest({ helperId: "helper", service: "utensils_once", homeSize: "one_two_bhk", firstTime, requestedStartDate: "2099-01-05" }, "POST"));
}
async function updateServices(f, services) {
  asHelper(f);
  return f.load(profileRoute).PUT(jsonRequest({ preserveAddress: true, travelDistanceKm: 5, yearsExperience: 2, services }));
}

test("Beta prospective pricing preserves old requests/bookings and prices later requests prospectively", async t => {
  const f = fixture(); t.after(() => f.sql.close()); seedOfferingAndSchedule(f); addResident(f, "resident2"); addResident(f, "resident3");
  const first = await requestOnce(f, "resident"); assert.equal(first.status, 200); const firstId = (await first.json()).requestId;
  assert.equal((await updateServices(f, once(60_000))).status, 200);
  assert.equal(f.sql.prepare("SELECT monthly_price_paise FROM booking_requests WHERE id=?").get(firstId).monthly_price_paise, 50_000);

  asHelper(f);
  const accepted = await f.load(helperRequestsRoute).POST(jsonRequest({ requestId: firstId, decision: "accept" }, "POST"));
  assert.equal(accepted.status, 200);
  assert.equal(f.sql.prepare("SELECT monthly_price_paise FROM booking_requests WHERE id=?").get(firstId).monthly_price_paise, 50_000);

  const second = await requestOnce(f, "resident2", "10:00"); assert.equal(second.status, 200); const secondId = (await second.json()).requestId;
  assert.equal(f.sql.prepare("SELECT monthly_price_paise FROM booking_requests WHERE id=?").get(secondId).monthly_price_paise, 60_000);

  assert.equal((await updateServices(f, houseOnly)).status, 200);
  const historical = f.sql.prepare("SELECT id,monthly_price_paise,status FROM booking_requests ORDER BY id").all();
  assert.equal(historical.find(row => row.id === firstId).monthly_price_paise, 50_000);
  assert.equal(historical.find(row => row.id === secondId).monthly_price_paise, 60_000);
  assert.equal(f.sql.prepare("SELECT count(*) count FROM bookings WHERE request_id=?").get(firstId).count, 1);
  const future = await requestOnce(f, "resident3", "11:00"); assert.equal(future.status, 409);
  assert.deepEqual(f.sql.prepare("SELECT id,monthly_price_paise,status FROM booking_requests ORDER BY id").all(), historical);
});

test("an older pending request remains decline-able after its offering is deactivated", async t => {
  const f = fixture(); t.after(() => f.sql.close()); seedOfferingAndSchedule(f);
  const response = await requestOnce(f, "resident"); const requestId = (await response.json()).requestId;
  assert.equal((await updateServices(f, houseOnly)).status, 200);
  asHelper(f);
  assert.equal((await f.load(helperRequestsRoute).POST(jsonRequest({ requestId, decision: "decline" }, "POST"))).status, 200);
  const stored = f.sql.prepare("SELECT monthly_price_paise,status FROM booking_requests WHERE id=?").get(requestId);
  assert.equal(stored.monthly_price_paise, 50_000); assert.equal(stored.status, "declined");
});

test("concurrent admission/update ordering records a coherent documented snapshot", async t => {
  const f = fixture(); t.after(() => f.sql.close()); seedOfferingAndSchedule(f);
  const originalPrepare = f.db.prepare.bind(f.db);
  f.db.prepare = query => {
    const statement = originalPrepare(query);
    if (query.includes("FROM helper_offerings WHERE helper_user_id = ? AND is_active = 1")) {
      const all = statement.all.bind(statement);
      statement.all = async () => { const result = await all(); f.db.beforeBatch = () => f.sql.exec("UPDATE helper_offerings SET monthly_price_paise=60000 WHERE id='offering'"); return result; };
    }
    return statement;
  };
  const response = await requestOnce(f, "resident"); assert.equal(response.status, 200);
  const row = f.sql.prepare("SELECT monthly_price_paise,status FROM booking_requests").get();
  assert.equal(row.monthly_price_paise, 50_000); assert.equal(row.status, "pending");
  assert.equal(f.sql.prepare("SELECT monthly_price_paise FROM helper_offerings WHERE id='offering'").get().monthly_price_paise, 60_000);
  assert.equal(f.sql.prepare("SELECT count(*) count FROM request_slots").get().count, 6);
  assert.ok(f.sql.prepare("SELECT count(*) count FROM slot_claims").get().count > 0);
});
