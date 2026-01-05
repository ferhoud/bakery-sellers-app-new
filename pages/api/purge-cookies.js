// pages/api/purge-cookies.js
export default async function handler(req, res) {
  try {
    const raw = req.headers.cookie || "";
    const names = raw
      .split(";")
      .map((p) => p.split("=")[0]?.trim())
      .filter(Boolean);

    // Uniq
    const uniq = Array.from(new Set(names));

    const secure = process.env.NODE_ENV === "production";
    const base = `Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure ? "; Secure" : ""}`;

    // On envoie 2 variantes par cookie (Path=/ et Path=/app au cas où)
    const setCookies = [];
    for (const n of uniq) {
      setCookies.push(`${n}=; ${base}`);
      setCookies.push(`${n}=; Path=/app; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure ? "; Secure" : ""}`);
    }

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "application/json");
    if (setCookies.length) res.setHeader("Set-Cookie", setCookies);

    res.status(200).json({ ok: true, cleared: uniq.length });
  } catch (e) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
