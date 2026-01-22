// pages/api/replacements/accept.js
// Une vendeuse accepte de remplacer une absence approuvee.
// - Change le planning (table shifts) pour ce slot
// - Enregistre replacement_interest en status=accepted
// - Service role pour eviter RLS

import { createClient } from "@supabase/supabase-js";

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return json(res, 500, { ok: false, error: "MISSING_SUPABASE_ENV" });

  const token = getBearer(req);
  if (!token) return json(res, 401, { ok: false, error: "NO_AUTH" });

  const authClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: u, error: uErr } = await authClient.auth.getUser(token);
  const user = u?.user;
  if (uErr || !user) return json(res, 401, { ok: false, error: "BAD_AUTH" });

  const body = req.body || {};
  const absenceId = body.absence_id || body.absenceId || null;
  const force = body.force === true || body.force === 1 || body.force === "1";
  if (!absenceId) return json(res, 400, { ok: false, error: "MISSING_ABSENCE_ID" });

  const admin = createClient(url, service, { auth: { persistSession: false } });

  // 1) Charger l'absence
  const { data: abs, error: absErr } = await admin
    .from("absences")
    .select("id, seller_id, date, status")
    .eq("id", absenceId)
    .maybeSingle();

  if (absErr || !abs) return json(res, 404, { ok: false, error: "ABSENCE_NOT_FOUND" });
  if (abs.status !== "approved") return json(res, 400, { ok: false, error: "NOT_APPROVED" });
  if (abs.seller_id === user.id) return json(res, 400, { ok: false, error: "CANNOT_REPLACE_SELF" });

  // 2) Trouver le shift de l'absente ce jour-la
  const { data: shiftRow, error: sErr } = await admin
    .from("shifts")
    .select("shift_code")
    .eq("date", abs.date)
    .eq("seller_id", abs.seller_id)
    .maybeSingle();

  if (sErr || !shiftRow?.shift_code) return json(res, 400, { ok: false, error: "NO_SHIFT_TO_REPLACE" });
  const shiftCode = shiftRow.shift_code;

  // 3) Si deja accepte par quelqu'un d'autre
  const { data: already, error: aErr } = await admin
    .from("replacement_interest")
    .select("id")
    .eq("absence_id", absenceId)
    .eq("status", "accepted")
    .maybeSingle();

  if (aErr) return json(res, 500, { ok: false, error: aErr.message || "REPL_CHECK_FAILED" });
  if (already?.id) return json(res, 409, { ok: false, error: "ALREADY_TAKEN" });

  // 4) Si la volontaire est deja planifiee ce jour-la, on autorise le "double shift"
  // (ex: elle fait deja le matin et remplace le soir) pour permettre une journee complete.
  const { data: mine, error: mineErr } = await admin
    .from("shifts")
    .select("shift_code")
    .eq("date", abs.date)
    .eq("seller_id", user.id)
    .maybeSingle();

  if (mineErr) return json(res, 500, { ok: false, error: mineErr.message || "SHIFT_CHECK_FAILED" });

  // 5) Mettre a jour le planning (atomic: seulement si le slot est encore assigne a l'absente)
  const { data: upd, error: updErr } = await admin
    .from("shifts")
    .update({ seller_id: user.id })
    .eq("date", abs.date)
    .eq("shift_code", shiftCode)
    .eq("seller_id", abs.seller_id)
    .select("date, shift_code, seller_id");

  if (updErr) return json(res, 500, { ok: false, error: updErr.message || "SHIFT_UPDATE_FAILED" });
  if (!upd || upd.length === 0) return json(res, 409, { ok: false, error: "ALREADY_TAKEN" });

  // 6) Enregistrer replacement_interest (accepted)
  const payload = {
    absence_id: absenceId,
    volunteer_id: user.id,
    status: "accepted",
    accepted_shift_code: shiftCode,
  };

  const { error: insErr } = await admin.from("replacement_interest").insert(payload);
  if (insErr) {
    const code = String(insErr.code || "");
    const msg = String(insErr.message || "").toLowerCase();
    const dup = code === "23505" || msg.includes("duplicate");
    if (dup) {
      const { error: upErr } = await admin
        .from("replacement_interest")
        .update({ status: "accepted", accepted_shift_code: shiftCode })
        .eq("absence_id", absenceId)
        .eq("volunteer_id", user.id);
      if (upErr) return json(res, 500, { ok: false, error: upErr.message || "REPL_UPSERT_FAILED" });
    } else {
      return json(res, 500, { ok: false, error: insErr.message || "REPL_INSERT_FAILED" });
    }
  }

  return json(res, 200, {
    ok: true,
    shift_code: shiftCode,
    date: abs.date,
    extra_shift: !!mine?.shift_code,
    your_shift_code: mine?.shift_code || null,
  });
}
