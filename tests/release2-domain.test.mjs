import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDays, validateInterval, normalizeIntervals, weeklyAvailability,
  commonStarts, serviceDurations, packagePrice, normalizePin,
  geographicEligibility, timeOptions, matchHelpers,
} from "../app/lib/release2-domain.ts";

// Public-contract adversaries are synthetic; none may invoke coercion hooks.
function malformedHouseSizes(onCoercion) {
  return [Object.freeze(["three_bhk"]), Object.freeze(new String("three_bhk")),
    Object.freeze({ toString() { onCoercion(); return "three_bhk"; } }),
    Object.freeze({ [Symbol.toPrimitive]() { onCoercion(); return "three_bhk"; } }),
    3, true, Object.freeze({}), "unsupported", undefined, Symbol("three_bhk"),
    () => "three_bhk", BigInt(3), NaN];
}

function malformedNumericEnums(onCoercion) {
  return [Object.freeze([1]), Object.freeze(new Number(1)), "1", true, null, undefined,
    Object.freeze({ valueOf() { onCoercion(); return 1; } }),
    Object.freeze({ [Symbol.toPrimitive]() { onCoercion(); return 1; } }),
    Symbol("1"), () => 1, BigInt(1), NaN, Infinity, 1.5, -1];
}

const ALL = [1, 2, 3, 4, 5, 6, 7];
const once = { houseSize: null, utensils: 1 };
const twice = { houseSize: null, utensils: 2 };
const combined = { houseSize: "three_bhk", utensils: 2, cleaningVisit: 1 };
const prices = { housePricesPaise: { one_two_bhk: 210000, three_bhk: 280000, four_plus_bhk: 350000 }, utensilsOncePaise: 140000, maxUtensilsVisits: 2 };
const location = { pin: "123456", coordinates: { latitude: 10, longitude: 20, confirmed: true } };
const fallback = { pin: "123456", coordinates: null };
const schedule = (overrides = {}) => ({ days: [...ALL], hours: { start: 360, end: 960 }, outside: [], commitments: [], ...overrides });
const span = (start, end, days = ALL) => ({ start, end, days });
const helper = (id = "helper-a", overrides = {}) => ({ id, schedule: schedule(), capabilities: prices, location, maxDistanceMeters: 50000, ...overrides });
const request = (overrides = {}) => ({ days: [...ALL], service: once, preferredStarts: [480], location, ...overrides });
const ids = matches => matches.map(match => match.helperId);

const houseOnly = { houseSize: "three_bhk", utensils: 0 };
const priceMapEntries = {
  packagePrice: capabilities => packagePrice(capabilities, houseOnly, ALL),
  matchHelpers: capabilities => matchHelpers(request({ service: houseOnly }), [helper("price-test", { capabilities })]),
};

for (const [name, invoke] of Object.entries(priceMapEntries)) {
  test(`${name} rejects the exact non-enumerable price reproduction without coercion`, () => {
    let coercions = 0;
    const housePricesPaise = Object.defineProperty({}, "three_bhk", {
      enumerable: false,
      value: { [Symbol.toPrimitive]() { coercions++; return 280000; } },
    });
    const capabilities = { housePricesPaise, utensilsOncePaise: null, maxUtensilsVisits: 0 };
    let result;
    assert.throws(() => { result = invoke(capabilities); }, TypeError);
    assert.equal(result, undefined);
    assert.equal(coercions, 0);
  });

  test(`${name} rejects hidden, accessor, symbolic, inherited and non-record price maps`, () => {
    let hooks = 0;
    const getter = () => { hooks++; return 280000; };
    const maps = [
      Object.defineProperty({}, "three_bhk", { value: 280000, enumerable: false }),
      Object.defineProperty({}, "three_bhk", { get: getter, enumerable: true }),
      Object.defineProperty({}, "three_bhk", { get: getter, enumerable: false }),
      Object.defineProperty({}, "three_bhk", { set() { hooks++; }, enumerable: true }),
      { three_bhk: 280000, [Symbol("hidden")]: 1 },
      { three_bhk: 280000, unexpected: 1 },
      Object.create({ three_bhk: 280000 }),
      Object.assign(Object.create({}), { three_bhk: 280000 }),
      [], new Number(280000), new String("280000"), () => 280000,
    ];
    for (const housePricesPaise of maps) {
      let result;
      assert.throws(() => { result = invoke({ housePricesPaise, utensilsOncePaise: null, maxUtensilsVisits: 0 }); }, TypeError);
      assert.equal(result, undefined);
    }
    assert.equal(hooks, 0);
  });

  test(`${name} rejects every malformed selected price before conversion`, () => {
    let hooks = 0;
    const values = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
      BigInt(280000), "280000", new Number(280000), [280000], null, undefined,
      { valueOf() { hooks++; return 280000; } },
      { toString() { hooks++; return "280000"; } },
      { [Symbol.toPrimitive]() { hooks++; return 280000; } }, () => 280000];
    for (const price of values) {
      const housePricesPaise = Object.freeze({ three_bhk: price });
      const capabilities = Object.freeze({ housePricesPaise, utensilsOncePaise: null, maxUtensilsVisits: 0 });
      assert.throws(() => invoke(capabilities), RangeError);
      assert.strictEqual(housePricesPaise.three_bhk, price);
    }
    assert.equal(hooks, 0);
  });
}

test("ordinary and null-prototype price records preserve all capability subsets and zero prices", () => {
  const sizes = ["one_two_bhk", "three_bhk", "four_plus_bhk"];
  for (let mask = 0; mask < 8; mask++) {
    for (const amount of [0, 280000, 8_000_000_000_000_000]) {
      const ordinary = Object.fromEntries(sizes.filter((_, i) => mask & (1 << i)).map(size => [size, amount]));
      const nullMap = Object.assign(Object.create(null), ordinary);
      const service = { houseSize: Object.keys(ordinary)[0] ?? null, utensils: mask ? 0 : 1 };
      const caps = map => ({ housePricesPaise: map, utensilsOncePaise: 0, maxUtensilsVisits: 1 });
      const expected = packagePrice(caps(ordinary), service, ALL);
      assert.deepEqual(packagePrice(caps(Object.freeze(nullMap)), service, ALL), expected);
      assert.equal(expected.sevenDayMonthlyPaise, mask ? amount : 0);
      const [match] = matchHelpers(request({ service }), [helper("valid", { capabilities: caps(nullMap) })]);
      assert.equal(match.kind, "full");
      assert.deepEqual(match.offers[0].price, expected);
      assert.deepEqual(Object.entries(nullMap), Object.entries(ordinary));
    }
  }
});

test("selected utensil prices obey the same primitive boundary", () => {
  let hooks = 0;
  for (const amount of [new Number(100), BigInt(100), "100", [100], null, undefined, -1, 0.5, NaN, Infinity,
    { [Symbol.toPrimitive]() { hooks++; return 100; } }]) {
    const capabilities = { housePricesPaise: {}, utensilsOncePaise: amount, maxUtensilsVisits: 1 };
    assert.throws(() => packagePrice(capabilities, once, ALL), RangeError);
    assert.throws(() => matchHelpers(request(), [helper("utensils", { capabilities })]), RangeError);
  }
  assert.equal(hooks, 0);
});

const recordBoundaries = [
  ["package", () => ({ ...once }), value => serviceDurations(value)],
  ["capabilities", () => ({ ...prices }), value => packagePrice(value, once, ALL)],
  ["location", () => ({ ...location }), value => geographicEligibility(value, location, 50000)],
  ["coordinates", () => ({ ...location.coordinates }), value => geographicEligibility({ ...location, coordinates: value }, location, 50000)],
  ["interval", () => ({ start: 0, end: 60 }), value => validateInterval(value)],
  ["weekly span", () => span(480, 510), value => weeklyAvailability(schedule({ outside: [value] }))],
  ["schedule", () => schedule(), value => commonStarts(value, ALL, 30)],
  ["request", () => request(), value => matchHelpers(value, [helper()])],
  ["helper", () => helper(), value => matchHelpers(request(), [value])],
];
for (const [name, create, invoke] of recordBoundaries) {
  test(`${name} rejects accessors, hidden properties and unexpected keys before reading`, () => {
    let getters = 0;
    const valid = create();
    for (const key of Object.keys(valid)) {
      const accessor = Object.defineProperty({ ...valid }, key, {
        enumerable: true, get() { getters++; return valid[key]; },
      });
      assert.throws(() => invoke(accessor), TypeError);
      const hidden = Object.defineProperty({ ...valid }, key, { enumerable: false });
      assert.throws(() => invoke(hidden), TypeError);
    }
    assert.throws(() => invoke({ ...valid, unexpected: 1 }), TypeError);
    assert.throws(() => invoke({ ...valid, [Symbol("hidden")]: 1 }), TypeError);
    assert.throws(() => invoke(Object.create(valid)), TypeError);
    assert.equal(getters, 0);
  });
}

test("array boundaries reject getters and custom iteration without executing caller code", () => {
  let hooks = 0;
  const boundaries = [
    [[1], value => normalizeDays(value)],
    [[{ start: 0, end: 60 }], value => normalizeIntervals(value)],
    [[480], value => timeOptions(schedule(), ALL, once, value)],
    [[1], value => timeOptions(schedule(), ALL, once, [480], value)],
    [[span(480, 510)], value => weeklyAvailability(schedule({ commitments: value }))],
    [[helper()], value => matchHelpers(request(), value)],
  ];
  for (const [valid, invoke] of boundaries) {
    const accessor = Object.defineProperty([...valid], "0", { enumerable: true, get() { hooks++; return valid[0]; } });
    assert.throws(() => invoke(accessor), TypeError);
    const iterator = Object.assign([...valid], { [Symbol.iterator]() { hooks++; return valid.values(); } });
    assert.throws(() => invoke(iterator), TypeError);
    const hidden = Object.defineProperty([...valid], "0", { enumerable: false });
    assert.throws(() => invoke(hidden), TypeError);
  }
  assert.equal(hooks, 0);
});

test("fully null-prototype input records produce identical results without input mutation", () => {
  function nullRecords(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(nullRecords));
    if (value && typeof value === "object") return Object.freeze(Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, child]) => [key, nullRecords(child)]))));
    return value;
  }
  const original = request({ service: combined, preferredStarts: [480, 720] });
  const helpers = [helper()];
  const inertRequest = nullRecords(original), inertHelpers = nullRecords(helpers);
  const before = JSON.stringify([inertRequest, inertHelpers]);
  assert.deepEqual(matchHelpers(inertRequest, inertHelpers), matchHelpers(original, helpers));
  assert.equal(JSON.stringify([inertRequest, inertHelpers]), before);
});

const packageEntryPoints = {
  serviceDurations: service => serviceDurations(service),
  packagePrice: service => packagePrice(prices, service, ALL),
  timeOptions: service => timeOptions(schedule(), ALL, service, [480]),
  matchHelpers: service => matchHelpers(request({ service }), [helper()]),
};

for (const [name, invoke] of Object.entries(packageEntryPoints)) {
  test(`${name} rejects every malformed house size without coercion or a result`, () => {
    let coercions = 0;
    for (const houseSize of malformedHouseSizes(() => coercions++)) {
      const service = Object.freeze({ houseSize, utensils: 1 });
      let result;
      assert.throws(() => { result = invoke(service); }, TypeError);
      assert.equal(result, undefined); // no full/partial offer, price or malformed output escapes
      assert.strictEqual(service.houseSize, houseSize);
      assert.equal(service.utensils, 1);
    }
    assert.equal(coercions, 0);
  });
}

test("valid null and every primitive house size preserve canonical packages across public entry points", () => {
  for (const [houseSize, expectedDuration] of [[null, 30], ["one_two_bhk", 60], ["three_bhk", 75], ["four_plus_bhk", 90]]) {
    const service = Object.freeze({ houseSize, utensils: 1 });
    assert.deepEqual(serviceDurations(service), [expectedDuration]);
    const price = packagePrice(prices, service, ALL);
    assert.equal(price.sevenDayMonthlyPaise, (houseSize === null ? 0 : prices.housePricesPaise[houseSize]) + prices.utensilsOncePaise);
    assert.deepEqual(timeOptions(schedule(), ALL, service, [480])[0].durations, [expectedDuration]);
    const [match] = matchHelpers(request({ service }), [helper()]);
    assert.equal(match.kind, "full");
    assert.strictEqual(match.offers[0].available.houseSize, houseSize);
    assert.strictEqual(match.offers[0].action.service.houseSize, houseSize);
    assert.deepEqual(match.offers[0].price, price);
    assert.deepEqual(service, { houseSize, utensils: 1 });
  }
});

test("service frequency and cleaning-visit enums reject coercible primitives through every package boundary", () => {
  let coercions = 0;
  const invalid = [...malformedNumericEnums(() => coercions++), 3];
  for (const invoke of Object.values(packageEntryPoints)) {
    for (const utensils of invalid) assert.throws(() => invoke(Object.freeze({ houseSize: "three_bhk", utensils })), RangeError);
    for (const cleaningVisit of invalid.filter(value => value !== undefined)) {
      assert.throws(() => invoke(Object.freeze({ houseSize: "three_bhk", utensils: 1, cleaningVisit })), RangeError);
    }
  }
  assert.equal(coercions, 0);
});

test("weekday enums reject coercible inputs in normalization, scheduling and matching", () => {
  let coercions = 0;
  for (const day of [...malformedNumericEnums(() => coercions++), 0, 8]) {
    const days = Object.freeze([day]);
    assert.throws(() => normalizeDays(days), RangeError);
    assert.throws(() => commonStarts(schedule(), days, 30), RangeError);
    assert.throws(() => matchHelpers(request({ days }), [helper()]), RangeError);
    assert.throws(() => weeklyAvailability(schedule({ days })), RangeError);
    assert.strictEqual(days[0], day);
  }
  assert.equal(coercions, 0);
});

test("capability frequency rejects boxed, coercible and unsupported values before pricing or matching", () => {
  let coercions = 0;
  for (const maxUtensilsVisits of [...malformedNumericEnums(() => coercions++), 3]) {
    const capabilities = Object.freeze({ ...prices, maxUtensilsVisits });
    assert.throws(() => packagePrice(capabilities, once, ALL), RangeError);
    assert.throws(() => matchHelpers(request(), [helper("invalid", { capabilities })]), RangeError);
    assert.strictEqual(capabilities.maxUtensilsVisits, maxUtensilsVisits);
  }
  assert.throws(() => packagePrice({ ...prices, housePricesPaise: { unsupported: 100 } }, once, ALL), TypeError);
  assert.equal(coercions, 0);
});

test("PIN, helper identity and coordinate confirmation reject boxed and coercible values", () => {
  let coercions = 0;
  for (const value of [new String("123456"), ["123456"], { toString() { coercions++; return "123456"; } }]) {
    assert.throws(() => normalizePin(value), TypeError);
    assert.throws(() => matchHelpers(request(), [helper(value)]), RangeError);
  }
  for (const confirmed of [new Boolean(true), [true], 1, "true", { valueOf() { coercions++; return true; } }]) {
    assert.throws(() => geographicEligibility(location, { ...location, coordinates: { ...location.coordinates, confirmed } }, 50000), RangeError);
  }
  assert.equal(coercions, 0);
});

test("all 127 nonempty weekday combinations require every selected day", () => {
  for (let mask = 1; mask < 128; mask++) {
    const days = ALL.filter(day => mask & (1 << (day - 1)));
    const work = schedule({ days, hours: { start: 480, end: 510 } });
    assert.deepEqual(commonStarts(work, days, 30), [480], `mask ${mask}`);
    assert.deepEqual(commonStarts({ ...work, commitments: [span(480, 510, [days.at(-1)])] }, days, 30), []);
    const missing = ALL.find(day => !days.includes(day));
    if (missing) assert.deepEqual(commonStarts(work, [...days, missing], 30), []);
  }
});

test("weekday normalization is stable, nonmutating and rejects malformed/empty input", () => {
  const days = Object.freeze([7, 1, 7, 3]);
  assert.deepEqual(normalizeDays(days), [1, 3, 7]);
  for (const value of [[], null, undefined, "123", [0], [8], [1.5], ["1"], [NaN]]) assert.throws(() => normalizeDays(value));
});

test("same-day intervals use the 15-minute grid and an unambiguous 1440 endpoint", () => {
  assert.deepEqual(validateInterval({ start: 0, end: 1440 }), { start: 0, end: 1440 });
  assert.deepEqual(commonStarts(schedule({ hours: { start: 1410, end: 1440 } }), [7], 30), [1410]);
  for (const value of [null, {}, { start: -15, end: 30 }, { start: 0, end: 1441 }, { start: 15, end: 15 },
    { start: 1380, end: 60 }, { start: 0, end: 16 }, { start: 1, end: 30 }, { start: "0", end: 30 },
    { start: NaN, end: 30 }, { start: 0, end: Infinity }, { start: 1440, end: 1440 }]) assert.throws(() => validateInterval(value));
  for (const value of [0, -15, 20, 1441, NaN, "30"]) assert.throws(() => commonStarts(schedule(), [1], value));
});

test("overlapping, adjacent and nested unavailable intervals normalize without mutation", () => {
  const input = [{ start: 120, end: 180 }, { start: 60, end: 150 }, { start: 75, end: 90 }, { start: 180, end: 210 }];
  const before = structuredClone(input);
  assert.deepEqual(normalizeIntervals(input), [{ start: 60, end: 210 }]);
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeIntervals([]), []);
  assert.throws(() => normalizeIntervals(null));
});

test("travel gaps apply before and after both outside and Nivasa commitments", () => {
  for (const source of ["outside", "commitments"]) {
    const starts = commonStarts(schedule({ [source]: [span(480, 540)] }), [1], 30);
    assert.ok(starts.includes(435)); // ends at 465, exactly 15 before commitment
    assert.ok(!starts.includes(450));
    assert.ok(!starts.includes(540));
    assert.ok(starts.includes(555));
  }
});

test("working boundaries need no extra outer travel time; nearby commitments still block inward", () => {
  const work = schedule({ hours: { start: 480, end: 600 } });
  assert.deepEqual(commonStarts(work, [1], 30), [480, 495, 510, 525, 540, 555, 570]);
  assert.deepEqual(commonStarts({ ...work, outside: [span(450, 480), span(600, 630)] }, [1], 30), [495, 510, 525, 540, 555]);
  assert.deepEqual(commonStarts({ ...work, outside: [span(420, 465), span(615, 645)] }, [1], 30), commonStarts(work, [1], 30));
  assert.deepEqual(commonStarts({ ...work, outside: [span(0, 1440)] }, [1], 30), []);
});

test("gap-expanded busy periods merge and the weekly preview contains intervals, never counts", () => {
  const preview = weeklyAvailability(schedule({ days: [1], hours: { start: 360, end: 720 },
    outside: [span(420, 450), span(480, 510)], commitments: [span(435, 465)] }));
  assert.deepEqual(preview[0], { day: 1, free: [{ start: 360, end: 405 }, { start: 525, end: 720 }] });
  assert.deepEqual(preview.slice(1).map(day => day.free), [[], [], [], [], [], []]);
});

test("individually available weekdays need not have any common recurring time", () => {
  const work = schedule({ hours: { start: 480, end: 600 }, outside: [span(525, 600, [1]), span(480, 555, [2])] });
  assert.ok(commonStarts(work, [1], 30).length);
  assert.ok(commonStarts(work, [2], 30).length);
  assert.deepEqual(commonStarts(work, [1, 2], 30), []);
});

test("all house sizes, utensil frequencies and combined visits use approved durations", () => {
  for (const [houseSize, minutes] of [["one_two_bhk", 30], ["three_bhk", 45], ["four_plus_bhk", 60]]) {
    assert.deepEqual(serviceDurations({ houseSize, utensils: 0 }), [minutes]);
    assert.deepEqual(serviceDurations({ houseSize, utensils: 1 }), [minutes + 30]);
    assert.deepEqual(serviceDurations({ houseSize, utensils: 2 }), [minutes + 30, 30]);
    assert.deepEqual(serviceDurations({ houseSize, utensils: 2, cleaningVisit: 2 }), [30, minutes + 30]);
  }
  assert.deepEqual(serviceDurations(once), [30]);
  assert.deepEqual(serviceDurations(twice), [30, 30]);
  for (const value of [null, {}, { houseSize: null, utensils: 0 }, { houseSize: "unknown", utensils: 1 },
    { ...once, utensils: 3 }, { ...once, cleaningVisit: 1 }, { houseSize: "three_bhk", utensils: 1, cleaningVisit: 2 }]) assert.throws(() => serviceDurations(value));
});

test("monthly and trial prices use the seven-day baseline and round only the final result", () => {
  assert.deepEqual(packagePrice(prices, combined, [1, 3, 5]), { sevenDayMonthlyPaise: 560000, monthlyPaise: 240000, trialDayPaise: 18700, twoDayTrialPaise: 37400 });
  assert.equal(packagePrice(prices, once, ALL).monthlyPaise, 140000);
  assert.equal(packagePrice(prices, twice, ALL).monthlyPaise, 280000);
  for (let count = 1; count <= 7; count++) assert.equal(packagePrice(prices, combined, ALL.slice(0, count)).trialDayPaise, 18700);
});

test("exact rational rounding covers immediately below, at and above half rupees", () => {
  for (const [baseline, expected] of [[349, 0], [350, 100], [351, 100], [1049, 100], [1050, 200], [1051, 200]]) {
    const caps = { ...prices, utensilsOncePaise: baseline };
    assert.equal(packagePrice(caps, once, [1]).monthlyPaise, expected);
  }
  for (const [baseline, expected] of [[1499, 0], [1500, 100], [1501, 100], [4499, 100], [4500, 200], [4501, 200]]) {
    const value = packagePrice({ ...prices, utensilsOncePaise: baseline }, once, [1]);
    assert.equal(value.trialDayPaise, expected);
    assert.equal(value.twoDayTrialPaise, expected * 2);
  }
  assert.equal(packagePrice({ ...prices, utensilsOncePaise: 175 }, twice, [1]).monthlyPaise, 100);
  assert.equal(packagePrice({ ...prices, utensilsOncePaise: 0 }, once, ALL).monthlyPaise, 0);
});

test("money intermediates remain exact and reject unsafe outputs and malformed capabilities", () => {
  const large = 8_000_000_000_000_000;
  assert.equal(packagePrice({ ...prices, utensilsOncePaise: large }, once, ALL).monthlyPaise, large);
  assert.throws(() => packagePrice({ ...prices, utensilsOncePaise: Number.MAX_SAFE_INTEGER }, twice, ALL));
  for (const value of [-1, 0.5, "100", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => packagePrice({ ...prices, utensilsOncePaise: value }, once, ALL));
  assert.throws(() => packagePrice({ ...prices, maxUtensilsVisits: 0 }, once, ALL));
  assert.throws(() => packagePrice({ ...prices, housePricesPaise: {} }, combined, ALL));
  assert.throws(() => packagePrice(prices, once, []));
});

test("single time options rank exact, 30, 60, then wider without a flexibility cutoff", () => {
  const options = timeOptions(schedule(), ALL, once, [480]);
  assert.equal(options[0].starts[0], 480);
  for (const [start, expectedTier] of [[480, 0], [450, 1], [510, 1], [420, 2], [540, 2], [405, 3], [555, 3]]) assert.equal(options.find(option => option.starts[0] === start).tier, expectedTier);
  assert.ok(options.every((option, i) => i === 0 || options[i - 1].worstDeviation <= option.worstDeviation));
});

test("joint pair enumeration finds an alternative that independent greedy picks miss", () => {
  const options = timeOptions(schedule({ hours: { start: 480, end: 720 } }), ALL, twice, [540, 570]);
  assert.ok(options.some(option => option.starts[0] === 525 && option.starts[1] === 570));
  assert.ok(!options.some(option => option.starts[0] === 540 && option.starts[1] === 570));
  assert.equal(options[0].worstDeviation, 15);
  assert.equal(options[0].combinedDeviation, 15);
  assert.equal(new Set(options.map(option => [...option.starts].sort((a, b) => a - b).join(":"))).size, options.length);
  assert.deepEqual(timeOptions(schedule({ hours: { start: 480, end: 540 } }), ALL, twice, [480, 525]), []);
});

test("pair ranking minimizes worse deviation then combined deviation, with stable ties", () => {
  const work = schedule({ outside: [span(480, 510, [7])] });
  const options = timeOptions(work, ALL, twice, [480, 660]);
  for (let i = 1; i < options.length; i++) {
    const a = options[i - 1], b = options[i];
    assert.ok(a.worstDeviation < b.worstDeviation || (a.worstDeviation === b.worstDeviation && a.combinedDeviation <= b.combinedDeviation));
  }
  assert.deepEqual(options, timeOptions(work, [...ALL].reverse(), twice, [480, 660]));
  for (const option of options) for (const [i, start] of option.starts.entries()) assert.ok(commonStarts(work, [7], option.durations[i]).includes(start));
  assert.throws(() => timeOptions(work, ALL, twice, [480, 480]));
  assert.throws(() => timeOptions(work, ALL, once, [481]));
  assert.throws(() => timeOptions(work, ALL, twice, [480]));
});

test("PIN fallback is normalized, explicit and cannot manufacture a distance", () => {
  assert.equal(normalizePin(" 123456 "), "123456");
  assert.deepEqual(geographicEligibility(fallback, { ...fallback, pin: " 123456 " }, 0), { kind: "same_pin", distanceMeters: null, label: "Distance unavailable" });
  assert.equal(geographicEligibility(fallback, { ...fallback, pin: "654321" }, 50000), null);
  assert.equal(geographicEligibility(location, fallback, 50000).distanceMeters, null);
  for (const value of [null, 123456, "12345", "1234567", "abcdef", "１２３４５６"]) assert.throws(() => normalizePin(value));
});

test("confirmed coordinates use the explicit radius; invalid/zero coordinates never become fallbacks", () => {
  assert.equal(geographicEligibility(location, location, 0).distanceMeters, 0); // genuine same location
  const distant = { ...location, coordinates: { latitude: 11, longitude: 20, confirmed: true } };
  assert.equal(geographicEligibility(location, distant, 100), null);
  assert.equal(geographicEligibility(location, { ...distant, coordinates: { ...distant.coordinates, confirmed: false } }, 100).kind, "same_pin");
  for (const coordinates of [undefined, {}, { latitude: null, longitude: null, confirmed: true },
    { latitude: 0, longitude: 0, confirmed: true }, { latitude: 91, longitude: 20, confirmed: true },
    { latitude: 10, longitude: NaN, confirmed: true }]) assert.throws(() => geographicEligibility(location, { ...location, coordinates }, 50000));
  assert.throws(() => geographicEligibility(location, location, -1));
});

test("superset capabilities satisfy the exact requested package and never charge the superset", () => {
  const [match] = matchHelpers(request(), [helper()]);
  assert.equal(match.kind, "full");
  assert.equal(match.offers.length, 1);
  assert.equal(match.offers[0].price.sevenDayMonthlyPaise, prices.utensilsOncePaise);
  assert.equal(match.offers[0].action.requiresSubsetConfirmation, false);
});

test("partial service returns only supported price, missing services and explicit confirmation", () => {
  const wanted = request({ service: combined, preferredStarts: [480, 720] });
  const onlyUtensils = helper("utensils", { capabilities: { ...prices, housePricesPaise: {}, maxUtensilsVisits: 1 } });
  const [match] = matchHelpers(wanted, [onlyUtensils]);
  assert.equal(match.kind, "partial");
  const offer = match.offers[0];
  assert.equal(offer.badge, "Partial service available");
  assert.deepEqual(offer.available, once);
  assert.deepEqual(offer.unavailable, { houseSize: "three_bhk", utensilsVisits: 1 });
  assert.equal(offer.price.sevenDayMonthlyPaise, 140000);
  assert.deepEqual(offer.options[0].durations, [30]);
  assert.equal(offer.action.label, "Book once-daily service");
  assert.equal(offer.action.requiresSubsetConfirmation, true);
  assert.deepEqual(wanted.service, combined);
});

test("a twice-capable helper with only one feasible visit can offer an explicit once-daily partial", () => {
  const [match] = matchHelpers(request({ service: twice, preferredStarts: [480, 540] }), [helper("one-window", { schedule: schedule({ hours: { start: 480, end: 510 } }) })]);
  assert.equal(match.kind, "partial");
  assert.equal(match.offers[0].available.utensils, 1);
  assert.deepEqual(match.offers[0].options[0].starts, [480]);
  assert.deepEqual(match.offers[0].options[0].requestedVisits, [1]);
});

test("house-only partial preserves the original house-visit preference", () => {
  const [match] = matchHelpers(request({ service: { ...combined, cleaningVisit: 2 }, preferredStarts: [480, 720] }),
    [helper("house", { capabilities: { ...prices, utensilsOncePaise: null, maxUtensilsVisits: 0 } })]);
  const offer = match.offers[0];
  assert.deepEqual(offer.options[0].starts, [720]);
  assert.deepEqual(offer.options[0].requestedVisits, [2]);
  assert.deepEqual(offer.options[0].durations, [45]);
  assert.equal(offer.price.sevenDayMonthlyPaise, 280000);
  assert.equal(offer.action.label, "Book available service");
});

test("no requested capabilities, absent weekdays and unavailable time produce no match", () => {
  assert.deepEqual(matchHelpers(request(), [helper("none", { capabilities: { housePricesPaise: {}, utensilsOncePaise: null, maxUtensilsVisits: 0 } })]), []);
  assert.deepEqual(matchHelpers(request(), [helper("days", { schedule: schedule({ days: [1] }) })]), []);
  assert.deepEqual(matchHelpers(request(), [helper("busy", { schedule: schedule({ outside: [span(0, 1440)] }) })]), []);
  assert.deepEqual(matchHelpers(request(), []), []);
});

test("full before partial, confirmed before fallback, then time, distance and stable helper ID", () => {
  const wanted = request({ service: combined, preferredStarts: [480, 720] });
  const partial = helper("partial", { capabilities: { ...prices, housePricesPaise: {} } });
  const pin = helper("pin", { location: fallback });
  const near = helper("near");
  const far = helper("far", { location: { ...location, coordinates: { latitude: 10.01, longitude: 20, confirmed: true } } });
  const late = helper("late", { schedule: schedule({ outside: [span(465, 510)] }) });
  const input = [partial, pin, late, far, near];
  assert.deepEqual(ids(matchHelpers(wanted, input)), ["near", "far", "late", "pin", "partial"]);
  assert.deepEqual(matchHelpers(wanted, input), matchHelpers(wanted, [...input].reverse()));
  assert.deepEqual(ids(matchHelpers(request(), [helper("z"), helper("a")])), ["a", "z"]);
});

test("domain functions never mutate deeply frozen caller input and results do not alias input", () => {
  function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  const wanted = freeze(request()), helpers = freeze([helper()]);
  const result = matchHelpers(wanted, helpers);
  result[0].offers[0].options[0].starts[0] = 123;
  assert.equal(wanted.preferredStarts[0], 480);
  assert.equal(matchHelpers(wanted, helpers)[0].offers[0].options[0].starts[0], 480);
});

test("malformed requests/helpers/schedules are rejected even with empty/ineligible candidates", () => {
  for (const value of [null, {}, request({ days: [] }), request({ preferredStarts: [] }), request({ preferredStarts: [481] })]) assert.throws(() => matchHelpers(value, []));
  assert.throws(() => matchHelpers(request(), null));
  assert.throws(() => matchHelpers(request(), [helper(), helper()]));
  assert.throws(() => matchHelpers(request(), [helper("")]));
  assert.throws(() => commonStarts(schedule({ outside: null }), ALL, 30));
  assert.throws(() => commonStarts(schedule({ commitments: [span(480, 510, [])] }), ALL, 30));
  assert.throws(() => matchHelpers(request({ preferredStarts: Array(1) }), []));
  assert.throws(() => timeOptions(schedule(), ALL, once, Array(1)));
  assert.throws(() => timeOptions(schedule(), ALL, once, [480], Array(1)));
  assert.throws(() => packagePrice({ ...prices, housePricesPaise: Object.create({ three_bhk: 100 }) }, combined, ALL));
});

test("combined money is summed before rounding, never rounded component by component", () => {
  const caps = { ...prices, housePricesPaise: { three_bhk: 350 }, utensilsOncePaise: 350 };
  const value = packagePrice(caps, { houseSize: "three_bhk", utensils: 1 }, [1]);
  assert.equal(value.monthlyPaise, 100); // two separately rounded components would incorrectly total 200
});

test("availability agrees with direct gap inequalities over a deterministic interval matrix", () => {
  for (let busyStart = 360; busyStart <= 660; busyStart += 15) {
    for (const length of [15, 30, 60]) {
      for (const serviceMinutes of [30, 45, 60, 75, 90]) {
        const work = schedule({ hours: { start: 420, end: 660 }, commitments: [span(busyStart, busyStart + length, [1])] });
        const expected = [];
        for (let start = 420; start + serviceMinutes <= 660; start += 15) {
          if (start + serviceMinutes + 15 <= busyStart || start >= busyStart + length + 15) expected.push(start);
        }
        assert.deepEqual(commonStarts(work, [1], serviceMinutes), expected);
      }
    }
  }
});

test("combined pair enumeration retains house-visit identity and the 15-minute inter-visit gap", () => {
  const work = schedule({ hours: { start: 480, end: 720 } });
  for (const cleaningVisit of [1, 2]) {
    const options = timeOptions(work, ALL, { ...combined, cleaningVisit }, [480, 600]);
    assert.ok(options.length > 0);
    for (const option of options) {
      const [a, b] = option.starts, [da, db] = option.durations;
      assert.ok(a + da + 15 <= b || b + db + 15 <= a);
      assert.equal(option.durations[cleaningVisit - 1], 75);
    }
  }
});

test("incomparable feasible subsets remain explicit alternatives under one helper", () => {
  const wanted = request({ service: { houseSize: "three_bhk", utensils: 1 }, preferredStarts: [480] });
  const result = matchHelpers(wanted, [helper("short", { schedule: schedule({ hours: { start: 480, end: 525 } }) })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "partial");
  assert.equal(result[0].offers.length, 2);
  assert.ok(result[0].offers.every(offer => offer.action.requiresSubsetConfirmation));
  assert.deepEqual(result[0].offers.map(offer => offer.price.sevenDayMonthlyPaise).sort((a, b) => a - b), [140000, 280000]);
});

test("a once-daily partial can explicitly select the second original preferred visit", () => {
  const [match] = matchHelpers(request({ service: twice, preferredStarts: [480, 720] }), [helper("evening", {
    capabilities: { ...prices, maxUtensilsVisits: 1 }, schedule: schedule({ hours: { start: 720, end: 750 } }),
  })]);
  assert.deepEqual(match.offers[0].options[0].starts, [720]);
  assert.deepEqual(match.offers[0].options[0].requestedVisits, [2]);
});

test("travel gaps cross midnight and Sunday-Monday without permitting overnight intervals", () => {
  const work = schedule({ hours: { start: 0, end: 1440 }, commitments: [span(1410, 1440, [7]), span(0, 30, [2])] });
  const monday = commonStarts(work, [1], 30);
  assert.ok(!monday.includes(0));
  assert.ok(monday.includes(15));
  assert.ok(monday.includes(1395));
  assert.ok(!monday.includes(1410));
  assert.ok(commonStarts(schedule({ hours: { start: 0, end: 1440 } }), [1], 30).includes(1410));
});

test("twice-daily pairs retain the travel gap between consecutive service days", () => {
  const work = schedule({ hours: { start: 0, end: 1440 } });
  assert.deepEqual(commonStarts(work, [1], 1440), [0]);
  assert.deepEqual(commonStarts(work, [1, 2], 1440), []);
  for (const days of [[1, 2], [7, 1]]) {
    const options = timeOptions(work, days, twice, [0, 1410]);
    assert.ok(!options.some(option => option.starts[0] === 0 && option.starts[1] === 1410));
    assert.ok(options.some(option => option.starts[0] === 15 && option.starts[1] === 1410));
  }
  assert.ok(timeOptions(work, [1, 3], twice, [0, 1410]).some(option => option.starts[0] === 0 && option.starts[1] === 1410));
});
