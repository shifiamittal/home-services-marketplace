import { betaTimeOptions, formatDisplayTime, weekdayOrder } from "../lib/helper-schedule";

const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function DayButtons({ legend, value, allowed, onChange }: {
  legend: string;
  value: number[];
  allowed?: number[];
  onChange: (value: number[]) => void;
}) {
  return <fieldset className="day-picker"><legend>{legend}</legend><div className="day-button-grid">{weekdayOrder.map(day => {
    const selected = value.includes(day);
    const disabled = allowed ? !allowed.includes(day) : false;
    return <label className={selected ? "selected" : ""} key={day}>
      <input type="checkbox" checked={selected} disabled={disabled} onChange={event => onChange(weekdayOrder.filter(item => item === day ? event.target.checked : value.includes(item)))}/>
      <span>{names[day]}</span>
    </label>;
  })}</div></fieldset>;
}

export function TimeSelect({ label, value, includeEnd, onChange }: {
  label: string;
  value: string;
  includeEnd?: boolean;
  onChange: (value: string) => void;
}) {
  return <label>{label}<select className="time-input large-time-select" value={value} onChange={event => onChange(event.target.value)}>
    <option value="">Select time</option>
    {betaTimeOptions(value, includeEnd).map(time => <option key={time} value={time}>{formatDisplayTime(time)}</option>)}
  </select></label>;
}
