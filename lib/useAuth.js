import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

export function useAuth() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(session ?? null);
      setLoading(false);
    };

    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session ?? null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let abort = false;
    const loadProfile = async () => {
      setProfile(null);
      if (!session?.user?.id) return;
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("user_id, full_name, role")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (!abort && !error) setProfile(data ?? null);
      } catch {}
    };
    loadProfile();
    return () => { abort = true; };
  }, [session?.user?.id]);

  return { session, profile, loading };
}
