import type { Dispatch, SetStateAction } from "react";

type HouseKey = "oneTwo" | "three" | "fourPlus";
type HouseSelection = Record<HouseKey, boolean>;
type HousePrices = Record<HouseKey, string>;

const houseOptions: Array<{ key: HouseKey; label: string; duration: number }> = [
  { key: "oneTwo", label: "1–2 BHK", duration: 30 },
  { key: "three", label: "3 BHK", duration: 45 },
  { key: "fourPlus", label: "4+ BHK", duration: 60 },
];

export function HelperServicePricing({
  offeringState, servicesChanged, houseSizes, setHouseSizes, housePrices, setHousePrices,
  utensilsEnabled, setUtensilsEnabled, utensilsTwice, setUtensilsTwice,
  utensilsOncePrice, setUtensilsOncePrice, markChanged, error,
}: {
  offeringState: "none" | "conforming" | "legacy_inconsistent";
  servicesChanged: boolean;
  houseSizes: HouseSelection;
  setHouseSizes: Dispatch<SetStateAction<HouseSelection>>;
  housePrices: HousePrices;
  setHousePrices: Dispatch<SetStateAction<HousePrices>>;
  utensilsEnabled: boolean;
  setUtensilsEnabled: Dispatch<SetStateAction<boolean>>;
  utensilsTwice: boolean;
  setUtensilsTwice: Dispatch<SetStateAction<boolean>>;
  utensilsOncePrice: string;
  setUtensilsOncePrice: Dispatch<SetStateAction<string>>;
  markChanged: () => void;
  error?: string;
}) {
  const replaceLegacy = () => {
    setHouseSizes({ oneTwo: false, three: false, fourPlus: false });
    setHousePrices({ oneTwo: "", three: "", fourPlus: "" });
    setUtensilsEnabled(false);
    setUtensilsTwice(false);
    setUtensilsOncePrice("");
    markChanged();
  };
  if (offeringState === "legacy_inconsistent" && !servicesChanged) return <div data-profile-field="offerings"><div className="info-banner"><span>i</span><p>Your saved service prices use an older format. They will stay unchanged unless you choose to replace them.</p><button type="button" className="secondary" onClick={replaceLegacy}>Replace saved services and prices</button></div>{error && <p className="field-error" role="alert">{error}</p>}</div>;
  return <div data-profile-field="offerings">
    <div className="service-price-block"><div className="inline-heading"><div><b>House cleaning</b><small>Sweeping, mopping, kitchen and bathroom surfaces; flush cleaning is not included</small></div></div>{houseOptions.map(option => <div className="price-option" key={option.key}><label className="toggle-row"><span><b>{option.label}</b><small>{option.duration} minutes per visit</small></span><input type="checkbox" checked={houseSizes[option.key]} onChange={event => { markChanged(); setHouseSizes(current => ({ ...current, [option.key]: event.target.checked })); }}/></label>{houseSizes[option.key] && <label className="field"><span>{option.label} monthly price</span><input className="text-input" aria-label={`${option.label} monthly price`} inputMode="decimal" value={housePrices[option.key]} placeholder="₹ monthly" onChange={event => { markChanged(); setHousePrices(current => ({ ...current, [option.key]: event.target.value.replace(/[^\d.]/g, "") })); }}/></label>}</div>)}</div>
    <div className="service-price-block"><label className="toggle-row"><span><b>Utensil cleaning</b></span><input type="checkbox" checked={utensilsEnabled} onChange={event => { markChanged(); setUtensilsEnabled(event.target.checked); if (!event.target.checked) setUtensilsTwice(false); }}/></label>{utensilsEnabled && <><label className="field"><span>Visits each day</span><select className="text-input" aria-label="Utensil cleaning visits each day" value={utensilsTwice ? "twice" : "once"} onChange={event => { markChanged(); setUtensilsTwice(event.target.value === "twice"); }}><option value="once">Once daily</option><option value="twice">Twice daily</option></select></label><label className="field"><span>Once-daily monthly price</span><input className="text-input" aria-label="Once-daily monthly price" inputMode="decimal" value={utensilsOncePrice} placeholder="₹ monthly" onChange={event => { markChanged(); setUtensilsOncePrice(event.target.value.replace(/[^\d.]/g, "")); }}/></label>{utensilsTwice && <div className="address-confirmed"><span>×2</span><span><b>Twice-daily price: ₹{Number.isFinite(Number(utensilsOncePrice)) ? (Number(utensilsOncePrice) * 2).toLocaleString("en-IN") : "—"} monthly</b><small>Calculated automatically from the once-daily price. Once-daily work remains available too.</small></span></div>}</>}</div>
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
