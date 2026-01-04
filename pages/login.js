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

async function hardClear() {
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
  const stay = String(r.query.stay || "") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [lastResp, setLastResp] = useState(null);

  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState(null);
  const [deciding, setDeciding] = useState(false);

  const user = useMemo(() => session?.user ?? null, [session]);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await withTimeout(supabase.auth.getSession(), 6000, "getSession timeout");
        if (!alive) return;

        // IMPORTANT: on valide côté serveur que le user est bien OK
        if (data?.session) {
          const { data: u, error: uErr } = await withTimeout(
            supabase.auth.getUser(),
            6000,
            "getUser timeout"
          );

          if (uErr || !u?.user) {
            // Session fantôme → on purge
            try { await supabase.auth.signOut(); } catch (_) {}
            await hardClear();
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

  useEffect(() => {
    const decide = async () => {
      if (stay) return;               // <-- mode debug: ne redirige pas
      if (checking) return;
      if (!user?.id) return;

      setDeciding(true);
      try {
        if (isAdminEmail(user.email)) {
          r.replace("/admin");
          return;
        }

        const { data: prof, error: profErr } = await withTimeout(
          supabase.from("profiles").select("role").eq("user_id", user.id).maybeSingle(),
          6000,
          "profiles role timeout"
        );

        if (!profErr && prof?.role === "admin") {
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
  }, [stay, checking, user?.id, user?.email, r.query.next, r]);

  async function ensureProfile(u) {
    if (!u?.id) return;
    const { data: existing } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("user_id", u.id)
      .maybeSingle();

    if (!existing) {
      const fullName =
        u.user_metadata?.full_name ||
        (u.email ? u.email.split("@")[0] : "Utilisateur");
      const role = isAdminEmail(u.email) ? "admin" : "seller";
      await supabase.from("profiles").insert({ user_id: u.id, full_name: fullName, role });
    }
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setLastResp(null);

    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;

      setSession(data?.session ?? null);

      await ensureProfile(data?.user);
      // laisse la logique decide() rediriger
    } catch (e2) {
      console.error("[login] error:", e2);
      setError(formatErr(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-4">
        <div className="text-xl font-semibold">Connexion</div>

        {(checking || deciding) && (
          <div className="text-sm p-2 rounded" style={{ background: "#f3f4f6" }}>
            Vérification…
          </div>
        )}

        <div className="text-xs opacity-70">
          Astuce: /login?stay=1 force l’affichage du formulaire même si une session existe.
        </div>

        <button type="button" className="btn w-full" onClick={() => (window.location.href = "/logout")} disabled={submitting}>
          Déconnexion hard (/logout)
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
