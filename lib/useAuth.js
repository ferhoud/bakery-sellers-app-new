
// touch: 2025-10-10 robust useAuth: no infinite loading, handles refresh, SSR-safe

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const AuthCtx = createContext({ session: null, profile: null, loading: true });

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // fetch profile helper
  const fetchProfile = async (sess) => {
    if (!sess?.user) { setProfile(null); return; }
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, role")
        .eq("user_id", sess.user.id)
        .single();
      if (error) {
        // RLS or not found shouldn't hard-crash the app
        console.warn("fetchProfile warning:", error.message);
        setProfile(null);
        return;
      }
      setProfile(data || null);
    } catch (e) {
      console.warn("fetchProfile failed:", e?.message || e);
      setProfile(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(data?.session || null);
        await fetchProfile(data?.session || null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    init();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      if (cancelled) return;
      setSession(sess);
      await fetchProfile(sess);
      // ensure we never hang
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
