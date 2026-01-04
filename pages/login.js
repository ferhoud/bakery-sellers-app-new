/* eslint-disable react/no-unescaped-entities */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { isAdminEmail } from "@/lib/admin";

function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function safeNext(nextRaw, isAdmin) {
  let next = nextRaw ? String(nextRaw) : "/app";
  if (!next.startsWith("/")) next = "/app";
  // sécurité: on empêche un vendeur d’être renvoyé vers /admin via ?next=/admin
  if (!isAdmin && next.startsWith("/admin")) next = "/app";
  // évite les trucs bizarres
  if (next.startsWith("/api")) next = "/app";
  return next;
}

async function clearAuthStorage() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") || k.includes("supabase"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}
  try {
    Object.keys(sessionStorage).forEach((k) => sessionStorage.removeItem(k));
  } catch (_) {}
}

export default function LoginPage() {
  const r = useRouter();

  const stay = String(r.query.stay || "") === "1"; // /login?stay=1 => ne redirige pas automatiquement
  const nextRaw = r.query.next ? String(r.query.next) : "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [lastResp, setLastResp] = useState(null);

  const [checking, setChecking] = useState(true);
  const [deciding, setDeciding] = useState(false);
  const [session, setSession] = useState(null);

  const user = useMemo(() => session?.user ?? null, [session]);

  // Source de vérité: Supabase (pas useAuth)
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await withTimeout(supabase.auth.getSession(), 6000, "getSession timeout");
        if (!alive) return;

        if (data?.session) {
          // valide la session côté Supabase (évite la “session fantôme” après logout)
          const { data: u, error: uErr } = await withTimeout(supabase.auth.getUser(), 6000, "getUser timeout");
          if (uErr || !u?.user) {
            try { await supabase.auth.signOut(); } catch (_) {}
            await clearAuthStorage();
            setSession(null);
          } else {
            setSession(data.session);
          }
        } else {
          setSession(null);
        }
      } catch (e) {
        console.error("[login] session check error:", e);
        setSession(null);
      } finally {
        if (alive) setChecking(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
      setChecking(false);
    });

    return () => {
      alive = false;
      try { sub?.subscription?.unsubscribe?.(); } catch (_) {}
    };
  }, []);

  // Redirect (admin par email > profil.role > next (sanitisé) > /app)
  useEffect(() => {
    const run = async () => {
      if (stay) return;
      if (checking) return;
      if (!user?.id) return;

      setDeciding(true);
      try {
        // admin direct si email whitelist
        if (isAdminEmail(user.email)) {
          r.replace("/admin");
          return;
        }

        // sinon check profil.role (timeout, et si erreur on ne boucle pas)
        const { data: prof, error: profErr } = await withTimeout(
          supabase.from("profiles").select("role").eq("user_id", user.id).maybeSingle(),
          6000,
          "profiles role timeout"
        );

        if (!profErr && prof?.role === "admin") {
          r.replace("/admin");
          return;
        }

        const next = safeNext(nextRaw, false);
        r.replace(next || "/app");
      } catch (e) {
        console.error("[login][redirect] error:", e);
      } finally {
        setDeciding(false);
      }
    };

    run();
  }, [stay, checking, user?.id, user?.email, nextRaw, r]);

  async function ensureProfile(u) {
    if (!u?.id) return;

    const { data: existing, error: exErr } = await withTimeout(
      supabase.from("profiles").select("user_id").eq("user_id", u.id).maybeSingle(),
      6000,
      "profiles existing timeout"
    );
    if (exErr) throw exErr;

    if (!existing) {
      const fullName =
        u.user_metadata?.full_name ||
        (u.email ? u.email.split("@")[0] : "Utilisateur");
      const role = isAdminEmail(u.email) ? "admin" : "seller";

      const { error: insErr } = await withTimeout(
        supabase.from("profiles").insert({ user_id: u.id, full_name: fullName, role }),
        6000,
        "profiles insert timeout"
      );
      if (insErr) throw insErr;
    }
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setLastResp(null);

    try {
      const { data, error: err } = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        12000,
        "signIn timeout"
      );

      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;

      // met à jour l’état local direct
      setSession(data?.session ?? null);

      await ensureProfile(data?.user);

      // laisse l’effet de redirect faire le boulot (avec safeNext)
    } catch (e2) {
      console.error("[login] error:", e2);
      setError(formatErr(e2));
    } finally {
      setSubmitting(false);
    }
  };

  const onHardLogout = async () => {
    setError(null);
    try { await supabase.auth.signOut(); } catch (_) {}
    await clearAuthStorage();
    window.location.replace("/login?stay=1&ts=" + Date.now());
  };

  const banner = (checking || deciding)
    ? "Vérification…"
    : (stay ? "Mode stay=1 (pas de redirection auto)" : null);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-4">
        <div className="text-xl font-semibold">Connexion</div>

        {banner && (
          <div className="text-sm p-2 rounded" style={{ background: "#f3f4f6" }}>
            {banner}
          </div>
        )}

        <div className="text-xs opacity-70">
          Si tu viens de /admin: utilise <b>/login?stay=1</b> pour forcer l’affichage du formulaire.
        </div>

        <button type="button" className="btn w-full" onClick={onHardLogout} disabled={submitting}>
          Réinitialiser session (hard)
        </button>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="text-sm">Email</label>
            <input
              type="email"
              required
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vous@example.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="text-sm">Mot de passe</label>
            <input
              type="password"
              required
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          <button type="submit" className="btn w-full" disabled={submitting}>
            {submitting ? "Connexion…" : "Se connecter"}
          </button>

          {error && (
            <div className="text-sm" style={{ color: "#b91c1c", whiteSpace: "pre-wrap" }}>
              {String(error)}
            </div>
          )}
        </form>

        {lastResp && (
          <details className="text-xs mt-2">
            <summary>Debug (réponse brute)</summary>
            <pre className="mt-1 p-2 bg-gray-100 rounded">{JSON.stringify(lastResp, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function serializeErr(err) {
  if (!err) return null;
  return { name: err.name, message: err.message, status: err.status };
}
function formatErr(e) {
  const msg = e?.message || String(e);
  const status = e?.status ? ` (status ${e.status})` : "";
  return `${msg}${status}`;
}
