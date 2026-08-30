import { daySummary, formatDisplayTime, type EditorWindow } from "../lib/helper-schedule";
import { DayButtons, TimeSelect } from "./helper-schedule-controls";

export function HelperWorkingHours({ value, onChange, legacy, onReplace, error }: {
  value: EditorWindow;
  onChange: (value: EditorWindow) => void;
  legacy: { kind: string; windows: EditorWindow[] } | null;
  onReplace: () => void;
  error?: string;
}) {
  return <section className="form-section" data-profile-field="availability"><h2>4. Working days and hours</h2>
    {legacy ? <>
      <p>Your existing schedule is preserved. Confirm a replacement only if you want to change it. You can save other profile details without changing these hours.</p>
      {legacy.kind === "invalid" ? <p role="alert">Your legacy schedule contains invalid days or hours and cannot be loaded into the editor.</p> :
        <ul>{legacy.windows.map(window => <li key={window.id}>{daySummary(window.days)}: {formatDisplayTime(window.start)}–{formatDisplayTime(window.end)}</li>)}</ul>}
      <button type="button" className="secondary" onClick={onReplace}>Replace my legacy schedule</button>
    </> : <>
      <p>Choose your working days and one common range for every selected day.</p>
      <DayButtons legend="Working days" value={value.days} onChange={days => onChange({ ...value, days })}/>
      <div className="time-grid"><TimeSelect label="Start" value={value.start} onChange={start => onChange({ ...value, start })}/><TimeSelect label="End" value={value.end} includeEnd onChange={end => onChange({ ...value, end })}/></div>
    </>}{error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
