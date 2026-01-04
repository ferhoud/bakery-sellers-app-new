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
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") || k.includes("supabase"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}

  try {
    Object.keys(sessionStorage).forEach((k) => sessionStorage.removeItem(k));
  } catch (_) {}

  // Best effort SW + caches (ça aide quand un vieux SW bloque des chunks)
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

  // Fallback anti-stale-session
  const [authChecked, setAuthChecked] = useState(false);
  const [localSession, setLocalSession] = useState(null);

  useEffect(() => {
    let alive = true;

    // Watchdog: quoi qu’il arrive, on ne bloque jamais la page plus de 8s
    const watchdog = setTimeout(() => {
      if (!alive) return;
      setAuthChecked(true);
    }, 8000);

    (async () => {
      try {
        const { data } = await withTimeout(
          supabase.auth.getSession(),
          6000,
          "getSession timeout"
        );
        if (!alive) return;
        setLocalSession(data?.session ?? null);
      } catch (e) {
        console.error("[login] getSession error:", e);
      } finally {
        if (alive) setAuthChecked(true);
        clearTimeout(watchdog);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(watchdog);
    };
  }, []);

  // IMPORTANT:
  // - Avant authChecked: on accepte hookSession (plus rapide)
  // - Après authChecked: on considère localSession comme source de vérité
  //   => si localSession est null, on ignore une hookSession stale
  const session = useMemo(() => {
    if (!authChecked) return hookSession || localSession || null;
    return localSession || null;
  }, [authChecked, hookSession, localSession]);

  // Après authChecked, on ne doit plus jamais rester sur "Chargement…" juste à cause du hook
  const loading = useMemo(() => {
    if (!authChecked) return !!hookLoading;
    return false;
  }, [authChecked, hookLoading]);

  useEffect(() => {
    const decide = async () => {
      // On décide UNIQUEMENT après authChecked, pour éviter les boucles avec hookSession stale
      if (!authChecked) return;
      if (!session?.user?.id) return;

      setDeciding(true);
      try {
        if (isAdminEmail(session.user.email)) {
          r.replace("/admin");
          return;
        }

        const { data: prof, error: profErr } = await withTimeout(
          supabase
            .from("profiles")
            .select("role")
            .eq("user_id", session.user.id)
            .maybeSingle(),
          6000,
          "profiles role timeout"
        );

        // Si erreur 401/permission, on ne boucle pas: on laisse la page login
        if (profErr) {
          console.warn("[login][decide] profiles error:", profErr);
          return;
        }

        if (prof?.role === "admin") {
          r.replace("/admin");
          return;
        }

        r.replace(r.query.next ? String(r.query.next) : "/app");
      } catch (e) {
        console.error("[login][decide] error:", e);
      } finally {
        setDeciding(false);
      }
    };

    decide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, session?.user?.id, session?.user?.email, r.query.next]);

  async function ensureProfile(user) {
    if (!user?.id) return;

    const { data: existing, error: exErr } = await withTimeout(
      supabase.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle(),
      6000,
      "profiles existing timeout"
    );

    if (exErr) throw exErr;

    if (!existing) {
      const fullName =
        user.user_metadata?.full_name ||
        (user.email ? user.email.split("@")[0] : "Utilisateur");
      const role = isAdminEmail(user.email) ? "admin" : "seller";

      const { error: insErr } = await withTimeout(
        supabase.from("profiles").insert({
          user_id: user.id,
          full_name: fullName,
          role,
        }),
        6000,
        "profiles insert timeout"
      );

      if (insErr) throw insErr;
    }
  }

  const redirectByRoleOrEmail = async (user) => {
    const next = r.query.next ? String(r.query.next) : "/app";

    if (isAdminEmail(user?.email)) {
      r.replace("/admin");
      return;
    }

    if (user?.id) {
      const { data: prof, error: profErr } = await withTimeout(
        supabase.from("profiles").select("role").eq("user_id", user.id).maybeSingle(),
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
      // Force aussi un signOut côté lib (mémoire)
      await supabase.auth.signOut();
    } catch (_) {}
    await clearAuthStorageAndCaches();
    window.location.href = "/login?clean=1&ts=" + Date.now();
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      console.log("[env] NEXT_PUBLIC_SUPABASE_URL:", process.env.NEXT_PUBLIC_SUPABASE_URL ? "ok" : "manquant");
      console.log("[env] NEXT_PUBLIC_SUPABASE_ANON_KEY:", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "ok" : "manquant");
    }
  }, []);

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
          title="Supprime tokens Supabase + caches (déblocage)"
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
