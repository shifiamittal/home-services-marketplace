import type { EditorWindow } from "../lib/helper-schedule";
import type { BusyEditorPeriod } from "../lib/helper-busy-periods";
import { clientEditorId } from "../lib/client-editor-id";
import { DayButtons, TimeSelect } from "./helper-schedule-controls";

export function HelperBusyPeriods({ working, value, enabled, onEnabled, onChange, error }: {
  working: EditorWindow;
  value: BusyEditorPeriod[];
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  onChange: (value: BusyEditorPeriod[]) => void;
  error?: string;
}) {
  const update = (id: string, patch: Partial<BusyEditorPeriod>) => onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  return <section className="form-section" data-profile-field="busyPeriods"><h2>5. Other work</h2><fieldset className="binary-choice"><legend>Do you work at another home during these hours?</legend><div>
    <label className={!enabled ? "selected" : ""}><input type="radio" name="external-work" checked={!enabled} onChange={() => { onEnabled(false); onChange([]); }}/><span>No</span></label>
    <label className={enabled ? "selected" : ""}><input type="radio" name="external-work" checked={enabled} onChange={() => onEnabled(true)}/><span>Yes</span></label>
  </div></fieldset>{enabled && <>{value.map((period, index) => <div className="availability-slot other-work-period" key={period.id}><h3>Work time {index + 1}</h3><DayButtons legend="Which days?" value={period.days} allowed={working.days} onChange={days => update(period.id, { days })}/><div className="time-grid"><TimeSelect label="From" value={period.start} onChange={start => update(period.id, { start })}/><TimeSelect label="To" value={period.end} includeEnd onChange={end => update(period.id, { end })}/></div><button type="button" className="text-button danger" onClick={() => onChange(value.filter(item => item.id !== period.id))}>Remove work time</button></div>)}<button type="button" className={value.length === 0 ? "primary" : "secondary"} onClick={() => onChange([...value, { id: clientEditorId(), days: [], start: working.start, end: working.end }])}>{value.length === 0 ? "Add first work time" : "Add another work time"}</button></>}{error && <p className="field-error" role="alert">{error}</p>}</section>;
}
