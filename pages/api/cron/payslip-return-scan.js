import { serviceSupabase, scanPayslipReturnCandidates } from "@/lib/server/payslipReturnRobot";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const authHeader = String(req.headers.authorization || req.headers.Authorization || "");
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return json(res, 401, { ok: false, error: "Unauthorized cron request" });
    }

    const service = serviceSupabase();
    const result = await scanPayslipReturnCandidates({ service, maxMessages: 40 });

    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
