// lib/useAuth.js
import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export function useAuth() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (cancelled) return;
        setSession(session || null);

        if (session?.user?.id) {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('user_id', session.user.id)
            .single();
          if (!cancelled) setProfile(error ? null : data);
        } else {
          if (!cancelled) setProfile(null);
        }
      } catch (e) {
        console.error('auth boot error', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    boot();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess || null);
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  return { session, profile, loading };
}
