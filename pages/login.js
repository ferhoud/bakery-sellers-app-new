/* eslint-disable react/no-unescaped-entities */
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
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
    // Supabase tokens (sb-*)
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") || k.includes("supabase"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}

  try {
    Object.keys(sessionStorage).forEach((k) => sessionStorage.removeItem(k));
  } catch (_) {}

  // Best-effort: service worker + caches
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
  const { session: hookSession, loading: hookLoading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [lastResp, setLastResp] = useState(null);

  const [deciding, setDeciding] = useState(false);

  // Fallback anti-blocage: on check nous-mêmes la session (au cas où useAuth reste bloqué)
  const [authChecked, setAuthChecked] = useState(false);
  const [localSession, setLocalSession] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await withTimeout(
          supabase.auth.getSession(),
          6000,
          "getSession timeout"
        );
        if (!alive) return;
        setLocalSession(data?.session ?? null);
      } catch (_) {
        // même si ça échoue, on ne bloque pas l’UI
      } finally {
        if (alive) setAuthChecked(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Session effective: on prend celle du hook si dispo, sinon fallback local
  const session = useMemo(() => hookSession || localSession || null, [hookSession, localSession]);

  // IMPORTANT: on ne bloque pas l’écran indéfiniment sur hookLoading
  const loading = useMemo(() => {
    // Tant qu’on n’a pas fait notre check local, on accepte le loading du hook.
    if (!authChecked) return !!hookLoading;
    // Après authChecked, on n’affiche plus jamais "Chargement…" uniquement à cause du hook
    return false;
  }, [authChecked, hookLoading]);

  useEffect(() => {
    const decide = async () => {
      if (!session?.user?.id) return;

      setDeciding(true);
      try {
        // si email admin connu -> /admin direct (pas besoin de profil)
        if (isAdminEmail(session.user.email)) {
          r.replace("/admin");
          return;
        }

        // sinon essaie le profil (avec timeout pour éviter blocage)
        const { data: prof } = await withTimeout(
          supabase
            .from("profiles")
            .select("role")
            .eq("user_id", session.user.id)
            .maybeSingle(),
          6000,
          "profiles role timeout"
        );

        if (prof?.role === "admin") {
          r.replace("/admin");
          return;
        }

        r.replace(r.query.next ? String(r.query.next) : "/app");
      } catch (e) {
        // Si la décision échoue, on ne bloque pas la page login
        console.error("[login][decide] error:", e);
      } finally {
        setDeciding(false);
      }
    };

    decide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, session?.user?.email, r.query.next]);

  async function ensureProfile(user) {
    if (!user?.id) return;

    const { data: existing } = await withTimeout(
      supabase.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle(),
      6000,
      "profiles existing timeout"
    );

    if (!existing) {
      const fullName =
        user.user_metadata?.full_name ||
        (user.email ? user.email.split("@")[0] : "Utilisateur");
      const role = isAdminEmail(user.email) ? "admin" : "seller";

      // nécessite la policy INSERT
      await withTimeout(
        supabase.from("profiles").insert({
          user_id: user.id,
          full_name: fullName,
          role,
        }),
        6000,
        "profiles insert timeout"
      );
    }
  }

  const redirectByRoleOrEmail = async (user) => {
    const next = r.query.next ? String(r.query.next) : "/app";

    if (isAdminEmail(user?.email)) {
      r.replace("/admin");
      return;
    }

    if (user?.id) {
      const { data: prof } = await withTimeout(
        supabase.from("profiles").select("role").eq("user_id", user.id).maybeSingle(),
        6000,
        "profiles role timeout"
      );

      if (prof?.role === "admin") {
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

      // 1) crée la ligne profil si manquante
      await ensureProfile(data?.user);
      // 2) redirige (email admin > profil.role > /app)
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
            emailRedirectTo:
              (typeof window !== "undefined" ? window.location.origin : "") + "/app",
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
    try {
      await clearAuthStorageAndCaches();
    } catch (_) {}
    // force reload sans cache logique
    window.location.href = "/login?clean=1&ts=" + Date.now();
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      console.log(
        "[env] NEXT_PUBLIC_SUPABASE_URL:",
        process.env.NEXT_PUBLIC_SUPABASE_URL ? "ok" : "manquant"
      );
      console.log(
        "[env] NEXT_PUBLIC_SUPABASE_ANON_KEY:",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "ok" : "manquant"
      );
    }
  }, []);

  // Ne jamais rester coincé indéfiniment: si deciding, on montre "Chargement…"
  if (loading || deciding) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm border rounded-2xl p-6 space-y-3">
          <div className="text-xl font-semibold">Chargement…</div>
          <div className="text-sm opacity-80">
            Si ça reste bloqué, clique sur "Débloquer".
          </div>
          <button type="button" className="btn w-full" onClick={onReset}>
            Débloquer (réinitialiser session)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-4">
        <div className="text-xl font-semibold">Connexion</div>

        <button
          type="button"
          className="btn w-full"
          onClick={onReset}
          disabled={submitting}
          title="Supprime les tokens locaux Supabase + caches (déblocage)"
        >
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

          <button
            type="button"
            className="btn w-full"
            onClick={onSendOtp}
            disabled={submitting}
          >
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
            <pre className="mt-1 p-2 bg-gray-100 rounded">
              {JSON.stringify(lastResp, null, 2)}
            </pre>
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
