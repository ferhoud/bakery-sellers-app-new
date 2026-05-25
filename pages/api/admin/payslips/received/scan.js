import { json, requireAdminOrJson, parseBody } from "@/lib/server/payslipReceivedApi";
import { scanPayslipReturnCandidates } from "@/lib/server/payslipReturnRobot";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

    const admin = await requireAdminOrJson(req, res);
    if (!admin) return;

    const body = parseBody(req);
    const result = await scanPayslipReturnCandidates({
      service: admin.service,
      payrollMonth: String(body?.payroll_month || body?.month || "").trim(),
      draftId: String(body?.payroll_email_draft_id || "").trim(),
      maxMessages: Number(body?.max_messages || 40) || 40,
    });

    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
