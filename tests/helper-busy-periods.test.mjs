import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixture, jsonRequest, profilePayload } from "./helpers/local-routes.mjs";

const profileRoute = "app/api/helper/profile/route.ts";
const working = [{ days: [1,2,3,4,5,6], start: "08:00", end: "12:00" }];
const services = { houseCleaning: [], utensils: { frequency: "once", onceDailyMonthlyPricePaise: 50_000 } };
function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.save = (busyPeriods, extra={}) => f.load(profileRoute).PUT(jsonRequest({ ...profilePayload, offerings: undefined, services, availability: working, busyPeriods, ...extra }));
  f.busy = () => f.sql.prepare("SELECT * FROM external_busy_periods ORDER BY created_at,id").all();
  return f;
}

test("busy periods add, edit, remove, retire and reload without exposing details", async t => {
  const f=setup(t); const first=[{ id:"draft",days:[1,3],start:"09:00",end:"10:00" }];
  assert.equal((await f.save(first)).status,200);
  let loaded=await (await f.load(profileRoute).GET(new Request("https://example.test/api"))).json();
  assert.deepEqual(loaded.busyPeriods[0].days,[1,3]); assert.doesNotMatch(JSON.stringify(loaded.busyPeriods),/resident|employer/i);
  assert.equal((await f.save([{ id:"draft",days:[1],start:"09:15",end:"10:15" }])).status,200);
  assert.equal(f.busy().filter(row=>row.status==="inactive").length,2);
  assert.equal((await f.save([])).status,200); assert.equal(f.busy().filter(row=>row.status==="active").length,0);
});

test("adjacent periods are allowed; overlaps, bad grids, outside hours and nonworking days are rejected", async t => {
  const f=setup(t);
  assert.equal((await f.save([{days:[1],start:"09:00",end:"10:00"},{days:[1],start:"10:00",end:"11:00"}])).status,200);
  for (const busy of [
    [{days:[1],start:"09:00",end:"10:00"},{days:[1],start:"09:45",end:"11:00"}],
    [{days:[1],start:"09:01",end:"10:00"}], [{days:[0],start:"09:00",end:"10:00"}], [{days:[1],start:"07:45",end:"09:00"}],
  ]) assert.ok([400,409].includes((await f.save(busy)).status));
});

test("schedule and busy changes roll back atomically and concurrent commitments win", async t => {
  const f=setup(t); const before=f.busy();
  f.sql.exec("CREATE TRIGGER fail_busy BEFORE INSERT ON external_busy_periods BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.equal((await f.save([{days:[1],start:"09:00",end:"10:00"}],{availability:[{days:[1],start:"07:00",end:"13:00"}]})).status,500);
  assert.deepEqual(f.busy(),before); assert.equal(f.sql.prepare("SELECT count(*) n FROM availability_slots WHERE status='open'").get().n,0);
  f.sql.exec("DROP TRIGGER fail_busy");
  f.db.beforeBatch=()=>{ f.sql.exec(`INSERT INTO availability_slots(id,helper_user_id,day_of_week,start_minute,end_minute,status) VALUES ('old','helper',1,480,720,'open'); INSERT INTO booking_requests(id,resident_user_id,helper_user_id,resident_address_id,package_snapshot_json,monthly_price_paise,requested_start_date,status,response_due_at) VALUES ('request','resident','helper','address','{"service":"utensils_once"}',50000,'2099-01-01','pending',datetime('now','+1 day')); INSERT INTO request_slots(id,request_id,availability_slot_id,visit_ordinal,day_of_week,start_minute,end_minute) VALUES ('rs','request','old',1,1,540,570)`); };
  const response=await f.save([{days:[1],start:"09:00",end:"10:00"}]); assert.equal(response.status,409); assert.ok((await response.json()).fields.busyPeriods);
});

test("matching and request admission exclude active external busy periods", async t => {
  const f=setup(t);
  f.sql.exec(`UPDATE helper_profiles SET home_address='Fixture',latitude_e6=10000000,longitude_e6=20000000,max_travel_distance_meters=100000,profile_status='active';
    INSERT INTO helper_offerings(id,helper_user_id,service_type,home_size,monthly_price_paise) VALUES ('off','helper','utensils_once','not_applicable',50000);
    INSERT INTO availability_slots(id,helper_user_id,day_of_week,start_minute,end_minute,status) VALUES ('m','helper',1,480,720,'open'),('t','helper',2,480,720,'open'),('w','helper',3,480,720,'open'),('th','helper',4,480,720,'open'),('f','helper',5,480,720,'open'),('s','helper',6,480,720,'open');
    INSERT INTO external_busy_periods(id,helper_user_id,day_of_week,start_minute,end_minute) VALUES ('busy','helper',3,540,600)`);
  f.session.user_id="resident"; f.session.roles=["resident"]; f.session.role="resident";
  const body={helperId:"helper",service:"utensils_once",homeSize:"one_two_bhk",firstTime:"09:00",secondTime:"",cleaningVisit:"first",weekdays:[1,2,3,4,5,6],requestedStartDate:"2099-01-01"};
  const matches=await f.load("app/api/resident/matches/route.ts").POST(jsonRequest({...body,flexibilityMinutes:0},"POST")); const matchBody=await matches.json(); assert.ok(Array.isArray(matchBody.matches),JSON.stringify(matchBody)); assert.equal(matchBody.matches.length,0);
  const request=await f.load("app/api/resident/requests/route.ts").POST(jsonRequest(body,"POST")); assert.equal(request.status,409); assert.equal(f.sql.prepare("SELECT count(*) n FROM booking_requests").get().n,0);
});

test("other-work UI uses plain language, canonical values and private mobile controls", t => {
  const f=setup(t); const {HelperBusyPeriods}=f.load("app/components/helper-busy-periods.tsx"); const noop=()=>{};
  const html=renderToStaticMarkup(createElement(HelperBusyPeriods,{working:{id:"w",days:[1,2],start:"08:00",end:"12:00"},value:[{id:"b",days:[1],start:"09:00",end:"10:00"}],enabled:true,onEnabled:noop,onChange:noop,error:"Fix busy time"}));
  assert.match(html,/Do you work at another home during these hours/); assert.match(html,/Add another work time/); assert.match(html,/Remove work time/); assert.match(html,/Which days\?/); assert.match(html,/value="09:00"[^>]*>9:00 AM/); assert.match(html,/Fix busy time/); assert.doesNotMatch(html,/employer|available slots|slot count|15-minute/i);
});

test("other-work add action follows first-then-another hierarchy", t => {
  const f=setup(t); const {HelperBusyPeriods}=f.load("app/components/helper-busy-periods.tsx"); const noop=()=>{};
  const props={working:{id:"w",days:[1],start:"08:00",end:"12:00"},enabled:true,onEnabled:noop,onChange:noop};
  const empty=renderToStaticMarkup(createElement(HelperBusyPeriods,{...props,value:[]}));
  assert.match(empty,/Add first work time/); assert.doesNotMatch(empty,/Add another work time|Work time 1/);
  const one=renderToStaticMarkup(createElement(HelperBusyPeriods,{...props,value:[{id:"one",days:[1],start:"09:00",end:"10:00"}]}));
  assert.match(one,/Work time 1[\s\S]*Add another work time/); assert.doesNotMatch(one,/Add first work time/);
});

test("profile save source retains drafts, binds fields, focuses errors, blocks duplicates and preserves proof retry",()=>{
  const source=readFileSync("app/page.tsx","utf8");
  for(const pattern of [/setupSavingRef\.current/,/result\.fields/,/scrollIntoView/,/\.focus\(\)/,/proofRetryRef/,/Address verification required/,/setSetupSubmitted\(true\)/,/setBusyPeriods\(result\.busyPeriods/]) assert.match(source,pattern);
  assert.doesNotMatch(source,/localStorage.*helper|available-slot count/i);
});

test("0012 migration applies to empty and representative legacy databases",()=>{
  const files=readdirSync("drizzle").filter(name=>/^\d{4}.*\.sql$/.test(name)).sort(); assert.equal(files.length,13);
  for(const representative of [false,true]) { const db=new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
    for(const file of files.slice(0,12)) db.exec(readFileSync(`drizzle/${file}`,"utf8"));
    if(representative) db.exec("INSERT INTO users(id,mobile_e164,name) VALUES ('legacy','+19999999999','Legacy'); INSERT INTO helper_profiles(user_id,home_locality) VALUES ('legacy','Pune')");
    db.exec(readFileSync(`drizzle/${files[12]}`,"utf8")); assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='external_busy_periods'").get()); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]); db.close(); }
});
