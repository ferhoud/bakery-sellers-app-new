import { createClient } from "@supabase/supabase-js";
import * as webpush from "web-push";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Petit verrou simple (mets une valeur dans Vercel + .env.local)
  const secret = req.headers["x-push-secret"];
  if (!process.env.PUSH_TEST_SECRET || secret !== process.env.PUSH_TEST_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const VAPID_PUBLIC =
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Missing Supabase env (URL or SERVICE ROLE)" });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(500).json({ error: "Missing VAPID env (public/private)" });
  }

  webpush.setVapidDetails(
    "mailto:admin@bm.local",
    VAPID_PUBLIC,
    VAPID_PRIVATE
  );

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, role, user_id");

  if (error) return res.status(500).json({ error: error.message });
  if (!subs || subs.length === 0) return res.status(200).json({ total: 0, ok: 0, failed: 0 });

  const payload = JSON.stringify({
    title: "Test Vente Rambouillet",
    body: "Si tu vois ça sur iPhone, on est bons ✅",
    url: "/admin",
    tag: "test-v1",
  });

  let ok = 0;
  const failures = [];
  const invalidIds = [];

  for (const s of subs) {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };

    try {
      // contentEncoding explicite (ça évite des surprises sur certains appareils)
      await webpush.sendNotification(subscription, payload, {
        TTL: 60,
        contentEncoding: "aes128gcm",
      });
      ok++;
    } catch (e) {
      const statusCode = e?.statusCode || null;
      failures.push({
        id: s.id,
        statusCode,
        endpoint: (s.endpoint || "").slice(0, 60) + "...",
        message: e?.message || String(e),
      });

      // 404/410 = subscription morte → on la purge
      if (statusCode === 404 || statusCode === 410) invalidIds.push(s.id);
    }
  }

  if (invalidIds.length) {
    await supabase.from("push_subscriptions").delete().in("id", invalidIds);
  }

  return res.status(200).json({
    total: subs.length,
    ok,
    failed: subs.length - ok,
    invalidDeleted: invalidIds.length,
    failures,
  });
}
