// lib/admin.js
export const ADMIN_EMAILS = new Set([
  "farid@bm.local", // ajoute d'autres emails si besoin
]);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email || "").toLowerCase());
}
