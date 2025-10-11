// components/LeaveRequestForm.js
import { useState, useMemo } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LeaveRequestForm() {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const invalid = !start || !end || end < start || start < todayIso;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (invalid) {
      alert("Vérifie les dates : pas de dates passées, et la fin doit être après le début.");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.from("leaves").insert({
        start_date: start,
        end_date: end,
        reason,
        status: "pending",
      });
      if (error) alert(error.message || "Échec de la demande de congé.");
      else {
        setStart(""); setEnd(""); setReason("");
        alert("Demande de congé envoyée !");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-3 border rounded-2xl bg-white">
      <h3 className="font-semibold text-lg">Demande de congé</h3>

      <div>
        <div className="text-sm mb-1">Début</div>
        <input
          type="date"
          className="input w-full"
          value={start}
          min={todayIso}
          onChange={(e) => {
            const v = e.target.value;
            setStart(v);
            if (end && end < v) setEnd(v); // force fin ≥ début
          }}
          required
        />
      </div>

      <div>
        <div className="text-sm mb-1">Fin</div>
        <input
          type="date"
          className="input w-full"
          value={end}
          min={start || todayIso}
          onChange={(e) => setEnd(e.target.value)}
          required
        />
      </div>

      <div>
        <div className="text-sm mb-1">Motif (optionnel)</div>
        <input
          type="text"
          className="input w-full"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ex: vacances"
        />
      </div>

      <button className="btn w-full" type="submit" disabled={submitting || invalid}>
        {submitting ? "Envoi…" : "Demander un congé"}
      </button>
    </form>
  );
}
