
import { requireAdmin, hhmmss, isIsoDate, minutesBetweenTimes } from "@/lib/server/adminApi";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { service, user } = admin;

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const work_date = String(body.work_date || "");
  const late_seller_id = String(body.late_seller_id || "");
  const shift_code = String(body.shift_code || "EVENING");
  const planned_start_time = hhmmss(body.planned_start_time || "13:30:00");
  const actual_arrival_time = hhmmss(body.actual_arrival_time || "");
  const coverage_status = String(body.coverage_status || "not_covered");
  const covering_seller_id = String(body.covering_seller_id || "");
  const coverage_start_time = hhmmss(body.coverage_start_time || planned_start_time || "");
  const coverage_end_time = hhmmss(body.coverage_end_time || actual_arrival_time || "");
  const notes = String(body.notes || "").trim();

  let late_minutes = Number(body.late_minutes || 0) || 0;
  if (!late_minutes && planned_start_time && actual_arrival_time) {
    late_minutes = minutesBetweenTimes(planned_start_time, actual_arrival_time) || 0;
  }

  if (!isIsoDate(work_date) || !late_seller_id || !planned_start_time || !actual_arrival_time || late_minutes <= 0) {
    return res.status(400).json({ error: "Données retard / relai invalides" });
  }
  if (!["covered", "not_covered", "dismissed"].includes(coverage_status)) {
    return res.status(400).json({ error: "coverage_status invalide" });
  }
  if (coverage_status === "covered" && !covering_seller_id) {
    return res.status(400).json({ error: "Choisis la vendeuse qui a couvert" });
  }
  if (coverage_status === "covered" && covering_seller_id === late_seller_id) {
    return res.status(400).json({ error: "La vendeuse qui couvre ne peut pas être la vendeuse en retard" });
  }

  const { data: existing } = await service
    .from("late_arrival_resolutions")
    .select("id, linked_extra_work_id")
    .eq("work_date", work_date)
    .eq("late_seller_id", late_seller_id)
    .eq("shift_code", shift_code)
    .maybeSingle();

  if (existing?.linked_extra_work_id) {
    await service.from("extra_work_entries").delete().eq("id", existing.linked_extra_work_id);
  }

  const params = {
    p_work_date: work_date,
    p_late_seller_id: late_seller_id,
    p_shift_code: shift_code,
    p_planned_start_time: planned_start_time,
    p_actual_arrival_time: actual_arrival_time,
    p_late_minutes: late_minutes,
    p_coverage_status: coverage_status,
    p_covering_seller_id: coverage_status === "covered" ? covering_seller_id : null,
    p_coverage_start_time: coverage_status === "covered" ? coverage_start_time : null,
    p_coverage_end_time: coverage_status === "covered" ? coverage_end_time : null,
    p_reason: "Couverture suite à un retard après-midi",
    p_notes: notes || null,
    p_created_by: user.id,
  };

  const { data, error } = await service.rpc("admin_resolve_late_arrival_coverage", params);
  if (error) return res.status(500).json({ error: error.message || "Erreur résolution retard / relai" });

  return res.status(200).json({ ok: true, row: Array.isArray(data) ? data[0] || null : data || null });
}
