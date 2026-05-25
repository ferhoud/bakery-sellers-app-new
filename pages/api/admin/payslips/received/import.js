import { json, requireAdminOrJson, parseBody } from "@/lib/server/payslipReceivedApi";
import { importPayslipReturnCandidate } from "@/lib/server/payslipReturnRobot";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

    const admin = await requireAdminOrJson(req, res);
    if (!admin) return;

    const body = parseBody(req);
    const id = String(body?.id || "").trim();

    const result = await importPayslipReturnCandidate({
      service: admin.service,
      candidateId: id,
      authorization: req.headers.authorization || req.headers.Authorization || "",
      req,
    });

    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
