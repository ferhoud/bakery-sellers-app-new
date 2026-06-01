import { requireAdmin } from "@/lib/server/adminApi";
import { loadPayrollAdjustmentPreview } from "@/lib/server/payrollAdjustments";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Méthode non autorisée" });
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const result = await loadPayrollAdjustmentPreview(admin.service, String(req.query?.month || ""));
    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Erreur serveur" });
  }
}
