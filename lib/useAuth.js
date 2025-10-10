// lib/useAuth.js
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const AuthCtx = createContext({ session: null, profile: null, loading: true });

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  async function fetchProfile(sess) {
    if (!sess?.user) { setProfile(null); return; }
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, role")
        .eq("user_id", sess.user.id)
        .single();
      if (error) { console.warn("fetchProfile:", error.message); setProfile(null); return; }
      setProfile(data || null);
    } catch (e) {
      console.warn("fetchProfile failed:", e?.message || e);
      setProfile(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(data?.session || null);
        await fetchProfile(data?.session || null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      if (cancelled) return;
      setSession(sess);
      await fetchProfile(sess);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  const value = useMemo(() => ({ session, profile, loading }), [session, profile, loading]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}

