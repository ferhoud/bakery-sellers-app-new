export default function handler(req, res) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json({
    ok: true,
    NEXT_PUBLIC_SUPABASE_URL: url ? `${url.slice(0, 20)}…` : null,
    NEXT_PUBLIC_SUPABASE_ANON_KEY_len: anon ? anon.length : 0,
    SUPABASE_SERVICE_ROLE_KEY_len: svc ? svc.length : 0,
  });
}
