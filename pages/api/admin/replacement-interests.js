// pages/api/admin/replacement-interests.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      // Service role côté serveur (PAS NEXT_PUBLIC)
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // fromDate = aujourd'hui (YYYY-MM-DD)
    const fromDate =
      (req.query.fromDate && String(req.query.fromDate)) ||
      new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("replacement_interest")
      .select(`
        id,
        status,
        volunteer_id,
        absence_id,
        absences!inner (
          id,
          date,
          seller_id,
          status
        )
      `)
      .eq("status", "pending")
      .eq("absences.status", "approved")
      .gte("absences.date", fromDate)
      // tri par la colonne "date" de la table liée "absences"
      .order("date", { referencedTable: "absences", ascending: true });

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ items: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
