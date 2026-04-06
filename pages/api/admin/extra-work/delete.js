
import { requireAdmin } from "@/lib/server/adminApi";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { service } = admin;

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const id = String(body.id || "");
  if (!id) return res.status(400).json({ error: "id manquant" });

  const { error } = await service.from("extra_work_entries").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message || "Erreur suppression" });
  return res.status(200).json({ ok: true });
}
