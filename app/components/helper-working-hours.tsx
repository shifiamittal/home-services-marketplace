import { formatMinute, weekdayOrder, type EditorWindow } from "../lib/helper-schedule";

const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
        <ul>{legacy.windows.map(window => <li key={window.id}>{window.days.map(day => names[day]).join(", ")}: {window.start}–{window.end}</li>)}</ul>}
      <button type="button" className="secondary" onClick={onReplace}>Replace my legacy schedule</button>
    </> : <>
      <p>Choose your working days and one common range for every selected day.</p>
      <fieldset><legend>Working days</legend>{weekdayOrder.map(day => <label key={day}>
        <input type="checkbox" checked={value.days.includes(day)} onChange={event => onChange({ ...value, days: weekdayOrder.filter(item => item === day ? event.target.checked : value.days.includes(item)) })}/>{names[day]}
      </label>)}</fieldset>
      <div className="time-grid">{(["start", "end"] as const).map(field => <label key={field}>{field === "start" ? "Start time" : "End time"}
        <select className="time-input" value={value[field]} onChange={event => onChange({ ...value, [field]: event.target.value })}>
          <option value="">Select time</option>{Array.from({ length: field === "start" ? 96 : 97 }, (_, index) => formatMinute(index * 15)).map(time => <option key={time} value={time}>{time}</option>)}
        </select>
      </label>)}</div>
    </>}{error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
