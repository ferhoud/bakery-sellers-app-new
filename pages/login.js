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

async function clearAuthStorageAndCaches() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") || k.includes("supabase"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}

  try {
    Object.keys(sessionStorage).forEach((k) => sessionStorage.removeItem(k));
  } catch (_) {}

  // Best effort: SW + caches (utile si un vieux SW garde des chunks)
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (_) {}

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {}
}

export default function LoginPage() {
  const r = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [lastResp, setLastResp] = useState(null);

  // Source de vérité: Supabase (pas useAuth)
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [info, setInfo] = useState(null);

  const isBusy = checking || deciding;

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await withTimeout(supabase.auth.getSession(), 6000, "getSession timeout");
        if (!alive) return;
        setSession(data?.session ?? null);
      } catch (e) {
        console.error("[login] getSession error:", e);
      } finally {
        if (alive) setChecking(false);
      }
    })();

    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
      setChecking(false);
    });

    return () => {
      alive = false;
      try {
        data?.subscription?.unsubscribe?.();
      } catch (_) {}
    };
  }, []);

  const user = useMemo(() => session?.user ?? null, [session]);

  useEffect(() => {
    const decide = async () => {
      if (!user?.id) return;

      setDeciding(true);
      setInfo("Redirection…");
      try {
        if (isAdminEmail(user.email)) {
          r.replace("/admin");
          return;
        }

        // profil.role (timeout + si erreur on ne boucle pas)
        const { data: prof, error: profErr } = await withTimeout(
          supabase.from("profiles").select("role").eq("user_id", user.id).maybeSingle(),
          6000,
          "profiles role timeout"
        );

        if (profErr) {
          console.warn("[login][decide] profiles error:", profErr);
          // On laisse la page login visible, pas de boucle
          setInfo(null);
          return;
        }

        if (prof?.role === "admin") {
          r.replace("/admin");
          return;
        }

        r.replace(r.query.next ? String(r.query.next) : "/app");
      } catch (e) {
        console.error("[login][decide] error:", e);
        setInfo(null);
      } finally {
        setDeciding(false);
      }
    };

    decide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.email, r.query.next]);

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

  const redirectByRoleOrEmail = async (u) => {
    const next = r.query.next ? String(r.query.next) : "/app";

    if (isAdminEmail(u?.email)) {
      r.replace("/admin");
      return;
    }

    if (u?.id) {
      const { data: prof, error: profErr } = await withTimeout(
        supabase.from("profiles").select("role").eq("user_id", u.id).maybeSingle(),
        6000,
        "profiles role timeout"
      );
      if (!profErr && prof?.role === "admin") {
        r.replace("/admin");
        return;
      }
    }

    r.replace(next);
  };

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

      // on force l’état local tout de suite
      if (data?.session) setSession(data.session);
      setChecking(false);

      await ensureProfile(data?.user);
      await redirectByRoleOrEmail(data?.user);
    } catch (e2) {
      console.error("[login] error:", e2);
      setError(formatErr(e2));
    } finally {
      setSubmitting(false);
    }
  };

  const onSendOtp = async () => {
    setError(null);
    setSubmitting(true);
    setLastResp(null);

    try {
      const { data, error: err } = await withTimeout(
        supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: (typeof window !== "undefined" ? window.location.origin : "") + "/app",
          },
        }),
        12000,
        "otp timeout"
      );

      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;
      alert("Email envoyé.");
    } catch (e) {
      console.error("[login][otp] error:", e);
      setError(formatErr(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onReset = async () => {
    setError(null);
    setInfo("Nettoyage…");
    try {
      await withTimeout(supabase.auth.signOut(), 5000, "signOut timeout");
    } catch (_) {}
    await clearAuthStorageAndCaches();
    window.location.href = "/login?clean=1&ts=" + Date.now();
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      console.log("[env] NEXT_PUBLIC_SUPABASE_URL:", process.env.NEXT_PUBLIC_SUPABASE_URL ? "ok" : "manquant");
      console.log("[env] NEXT_PUBLIC_SUPABASE_ANON_KEY:", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "ok" : "manquant");
      console.log("[login] checking:", checking, "hasSession:", !!session);
    }
  }, [checking, session]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-4">
        <div className="text-xl font-semibold">Connexion</div>

        {isBusy && (
          <div className="text-sm p-2 rounded" style={{ background: "#f3f4f6" }}>
            {info || "Vérification…"}
          </div>
        )}

        <button type="button" className="btn w-full" onClick={onReset} disabled={submitting}>
          Débloquer (réinitialiser session)
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

          <button type="button" className="btn w-full" onClick={onSendOtp} disabled={submitting}>
            Tester par lien magique (OTP)
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
