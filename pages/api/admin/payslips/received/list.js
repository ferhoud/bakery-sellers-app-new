import { json, requireAdminOrJson } from "@/lib/server/payslipReceivedApi";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const admin = await requireAdminOrJson(req, res);
    if (!admin) return;

    const month = String(req.query?.month || "").trim().slice(0, 7);
    const status = String(req.query?.status || "").trim();

    let q = admin.service
      .from("payroll_payslip_return_candidates")
      .select("*")
      .order("gmail_received_at", { ascending: false })
      .limit(200);

    if (/^\d{4}-\d{2}$/.test(month)) q = q.eq("payroll_month", `${month}-01`);
    if (status) q = q.eq("status", status);

    const { data, error } = await q;
    if (error) throw error;

    return json(res, 200, { ok: true, rows: data || [] });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
