// lib/useAuth.js
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';

const AuthCtx = createContext({ session: null, profile: null, loading: true });

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const failSafe = setTimeout(() => { if (!cancelled) setLoading(false); }, 1500);

    const boot = async () => {
      try {
        const { data: { session: s } } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(s || null);

        if (s?.user?.id) {
          const { data: prof } = await supabase
            .from('profiles')
            .select('user_id, full_name, role, active')
            .eq('user_id', s.user.id)
            .maybeSingle();
          if (!cancelled) setProfile(prof || null);
        } else {
          setProfile(null);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    boot();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (cancelled) return;
      setSession(s || null);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      clearTimeout(failSafe);
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  const value = useMemo(() => ({ session, profile, loading }), [session, profile, loading]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
