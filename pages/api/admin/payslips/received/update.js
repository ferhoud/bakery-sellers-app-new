import { json, requireAdminOrJson, parseBody } from "@/lib/server/payslipReceivedApi";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

    const admin = await requireAdminOrJson(req, res);
    if (!admin) return;

    const body = parseBody(req);
    const id = String(body?.id || "").trim();
    const status = String(body?.status || "").trim();
    const reviewNote = String(body?.review_note || "").trim();

    if (!id) return json(res, 400, { ok: false, error: "id manquant" });
    if (!["detected", "ignored"].includes(status)) {
      return json(res, 400, { ok: false, error: "status invalide" });
    }

    const { data, error } = await admin.service
      .from("payroll_payslip_return_candidates")
      .update({
        status,
        review_note: reviewNote || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;
    return json(res, 200, { ok: true, row: data });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
