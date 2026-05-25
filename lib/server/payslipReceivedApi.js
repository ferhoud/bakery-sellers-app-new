import { requireAdmin } from "@/lib/server/adminApi";

export function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

export async function requireAdminOrJson(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return null;
  return admin;
}

export function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_) {
      return {};
    }
  }
  return req.body || {};
}
