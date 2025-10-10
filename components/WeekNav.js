// components/weeknav.js
// Encodage recommandé : UTF-8

import { addDays, fmtISODate } from "../lib/date";

const PREV_LABEL  = "Semaine pr\u00E9c\u00E9dente"; // “précédente”
const TODAY_LABEL = "Semaine en cours";
const NEXT_LABEL  = "Semaine suivante";

export default function WeekNav({ monday, onPrev, onToday, onNext }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  return (
    <div className="flex items-center gap-2 mb-3">
      <button type="button" className="btn" onClick={onPrev}>
        {PREV_LABEL}
      </button>
      <button type="button" className="btn" onClick={onToday}>
        {TODAY_LABEL}
      </button>
      <button type="button" className="btn" onClick={onNext}>
        {NEXT_LABEL}
      </button>

      <div className="ml-auto text-sm text-gray-600">
        {fmtISODate(days[0])} {"\u2192"} {fmtISODate(days[6])}
      </div>
    </div>
  );
}
