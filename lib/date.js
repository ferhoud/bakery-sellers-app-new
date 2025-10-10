
export function startOfWeek(d=new Date()){
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day; // Monday as first day
  date.setDate(date.getDate() + diff);
  date.setHours(0,0,0,0);
  return date;
}
export function addDays(date, days){
  const d = new Date(date);
  d.setDate(d.getDate()+days);
  return d;
}
export function fmtISODate(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), da=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}
export const SHIFT_LABELS = {
  MORNING: "Matin (6h30-13h30)",
  MIDDAY: "Midi (7h-13h)",
  EVENING: "Soir (13h30-20h30)",
};



