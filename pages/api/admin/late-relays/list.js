
import { requireAdmin, hhmmFromMinutes, isIsoDate } from "@/lib/server/adminApi";

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

  const [{ data: shifts, error: shiftsError }, { data: checkins, error: checkinsError }, { data: resolutions, error: resError }] = await Promise.all([
    service
      .from("shifts")
      .select("date, shift_code, seller_id")
      .in("shift_code", ["EVENING", "MIDDAY", "MORNING"])
      .gte("date", from)
      .lte("date", to),
    service
      .from("daily_checkins")
      .select("day, seller_id, late_minutes, confirmed_at")
      .gte("day", from)
      .lte("day", to)
      .gt("late_minutes", 0)
      .not("confirmed_at", "is", null),
    service
      .from("late_arrival_resolutions")
      .select("work_date, late_seller_id, shift_code")
      .gte("work_date", from)
      .lte("work_date", to),
  ]);

  if (shiftsError) return res.status(500).json({ error: shiftsError.message || "Erreur lecture shifts" });
  if (checkinsError) return res.status(500).json({ error: checkinsError.message || "Erreur lecture pointages" });
  if (resError) return res.status(500).json({ error: resError.message || "Erreur lecture retards" });

  const eveningByKey = new Map();
  const coverSuggestionByDate = new Map();
  (shifts || []).forEach((row) => {
    const key = `${row.date}|${row.seller_id}`;
    if (row.shift_code === "EVENING") eveningByKey.set(key, row);
    if ((row.shift_code === "MIDDAY" || row.shift_code === "MORNING") && !coverSuggestionByDate.has(row.date)) {
      coverSuggestionByDate.set(row.date, row.seller_id);
    }
  });

  const resolvedSet = new Set((resolutions || []).map((r) => `${r.work_date}|${r.late_seller_id}|${r.shift_code || "EVENING"}`));

  const rows = [];
  (checkins || []).forEach((row) => {
    const date = row.day;
    const sellerId = row.seller_id;
    const lateMinutes = Number(row.late_minutes || 0) || 0;
    if (!date || !sellerId || lateMinutes <= 0) return;
    const eveningKey = `${date}|${sellerId}`;
    if (!eveningByKey.has(eveningKey)) return;
    const resolutionKey = `${date}|${sellerId}|EVENING`;
    if (resolvedSet.has(resolutionKey)) return;

    rows.push({
      work_date: date,
      late_seller_id: sellerId,
      shift_code: "EVENING",
      planned_start_time: "13:30:00",
      actual_arrival_time: hhmmFromMinutes(13 * 60 + 30 + lateMinutes),
      late_minutes: lateMinutes,
      suggested_covering_seller_id: coverSuggestionByDate.get(date) || null,
      source: "checkin_detected",
    });
  });

  rows.sort((a, b) => {
    if (a.work_date === b.work_date) return a.actual_arrival_time.localeCompare(b.actual_arrival_time);
    return a.work_date.localeCompare(b.work_date);
  });

  return res.status(200).json({ rows });
}
