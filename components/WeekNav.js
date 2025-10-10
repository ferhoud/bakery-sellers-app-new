
import { addDays, startOfWeek, fmtISODate } from "../lib/date";

export default function WeekNav({ monday, onPrev, onToday, onNext }){
  const days = Array.from({length:7}).map((_,i)=> addDays(monday,i));
  return (
    <div className="flex items-center gap-2 mb-3">
      <button className="btn" onClick={onPrev}>Semaine prÃ©cÃ©dente</button>
      <button className="btn" onClick={onToday}>Semaine en cours</button>
      <button className="btn" onClick={onNext}>Semaine suivante</button>
      <div className="ml-auto text-sm text-gray-600">
        {fmtISODate(days[0])} â†’ {fmtISODate(days[6])}
      </div>
    </div>
  );
}


