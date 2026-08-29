import { formatMinute, weekdayOrder, type EditorWindow } from "../lib/helper-schedule";
import type { BusyEditorPeriod } from "../lib/helper-busy-periods";

const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const times = Array.from({ length: 97 }, (_, index) => formatMinute(index * 15));

export function HelperBusyPeriods({ working, value, enabled, onEnabled, onChange, error }: {
  working: EditorWindow;
  value: BusyEditorPeriod[];
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  onChange: (value: BusyEditorPeriod[]) => void;
  error?: string;
}) {
  const update = (id: string, patch: Partial<BusyEditorPeriod>) => onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  return <section className="form-section" data-profile-field="busyPeriods"><h2>5. Other work</h2><fieldset><legend>Do you already have work during these hours?</legend>
    <label><input type="radio" name="external-work" checked={!enabled} onChange={() => { onEnabled(false); onChange([]); }}/>No</label>
    <label><input type="radio" name="external-work" checked={enabled} onChange={() => onEnabled(true)}/>Yes</label>
  </fieldset>{enabled && <><p>Add recurring periods that residents should see only as Busy.</p>{value.map((period, index) => <div className="availability-slot" key={period.id}><fieldset><legend>Busy period {index + 1} days</legend>{weekdayOrder.map(day => <label key={day}><input type="checkbox" checked={period.days.includes(day)} disabled={!working.days.includes(day)} onChange={event => update(period.id, { days: weekdayOrder.filter(item => item === day ? event.target.checked : period.days.includes(item)) })}/>{names[day]}</label>)}</fieldset><div className="time-grid"><label>Start<select className="time-input" value={period.start} onChange={event => update(period.id, { start: event.target.value })}><option value="">Select time</option>{times.slice(0, -1).map(time => <option key={time}>{time}</option>)}</select></label><label>End<select className="time-input" value={period.end} onChange={event => update(period.id, { end: event.target.value })}><option value="">Select time</option>{times.map(time => <option key={time}>{time}</option>)}</select></label></div><button type="button" className="text-button danger" onClick={() => onChange(value.filter(item => item.id !== period.id))}>Remove busy period</button></div>)}<button type="button" className="secondary" onClick={() => onChange([...value, { id: crypto.randomUUID(), days: [], start: working.start, end: working.end }])}>+ Add busy period</button></>}{error && <p className="field-error" role="alert">{error}</p>}</section>;
}
