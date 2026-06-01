import { requireAdmin } from "@/lib/server/adminApi";
import { loadPayrollAdjustmentPreview } from "@/lib/server/payrollAdjustments";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function getServiceClient(auth) {
  if (!auth) return null;
  if (typeof auth.from === "function") return auth;
  if (auth.service && typeof auth.service.from === "function") return auth.service;
  if (auth.admin && typeof auth.admin.from === "function") return auth.admin;
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Méthode non autorisée" });
    }

    const auth = await requireAdmin(req, res);
    if (!auth) return;

    const service = getServiceClient(auth);
    if (!service) {
      return json(res, 500, { ok: false, error: "Client Supabase admin introuvable." });
    }

    const month = String(req.query?.month || "").trim();
    const result = await loadPayrollAdjustmentPreview(service, month);

    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Erreur serveur" });
  }
}
