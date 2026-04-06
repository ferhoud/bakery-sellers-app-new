
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
  const seller_id = String(body.seller_id || "");
  const start_time = hhmmss(body.start_time || "");
  const end_time = hhmmss(body.end_time || "");
  const kind = String(body.kind || "manual_extra");
  const reason = String(body.reason || "Travail en plus").trim();
  const notes = String(body.notes || "").trim();

  if (!isIsoDate(work_date) || !seller_id || !start_time || !end_time) {
    return res.status(400).json({ error: "Données incomplètes" });
  }
  if (!["manual_extra", "coverage", "relay"].includes(kind)) {
    return res.status(400).json({ error: "Type invalide" });
  }

  const minutes = minutesBetweenTimes(start_time, end_time);
  if (!minutes || minutes <= 0) {
    return res.status(400).json({ error: "Plage horaire invalide" });
  }

  const { data, error } = await service
    .from("extra_work_entries")
    .insert({
      work_date,
      seller_id,
      start_time,
      end_time,
      minutes,
      kind,
      reason,
      notes: notes || null,
      source: "ADMIN",
      created_by: user.id,
    })
    .select("id, work_date, seller_id, start_time, end_time, minutes, kind, reason, notes")
    .single();

  if (error) return res.status(500).json({ error: error.message || "Erreur création travail en plus" });
  return res.status(200).json({ row: data });
}
