
import { requireAdmin, isIsoDate } from "@/lib/server/adminApi";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Méthode non autorisée" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { service } = admin;

  const from = String(req.query?.from || "");
  const to = String(req.query?.to || from || "");
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return res.status(400).json({ error: "Paramètres from/to invalides" });
  }

  const { data, error } = await service
    .from("extra_work_entries")
    .select("id, work_date, seller_id, start_time, end_time, minutes, kind, reason, notes, source, created_at")
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) return res.status(500).json({ error: error.message || "Erreur lecture travail en plus" });
  return res.status(200).json({ rows: data || [] });
}
