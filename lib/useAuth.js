// lib/useAuth.js — hook/Provider tolérant (ne jette plus d'erreur si profil absent)
/* eslint-disable react-hooks/exhaustive-deps */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(null);

  // Charge session
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(session ?? null);
      setLoading(false);
    };
    init();

    // Ecoute les changements d'auth
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess ?? null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Charge le profil (si possible), mais NE bloque pas si absent/RLS
  const loadProfile = async (uid) => {
    if (!uid) { setProfile(null); return; }
    setProfileLoading(true);
    setProfileError(null);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();
      if (error) throw error;
      setProfile(data ?? null);
    } catch (e) {
      // On mémorise l’erreur, mais on ne casse pas l’app
      setProfile(null);
      setProfileError(e);
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    loadProfile(session?.user?.id);
  }, [session?.user?.id]);

  const value = useMemo(() => ({
    session,
    loading,
    profile,
    profileLoading,
    profileError,
    refreshProfile: () => loadProfile(session?.user?.id),
  }), [session, loading, profile, profileLoading, profileError]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) {
    return {
      session: null,
      loading: true,
      profile: null,
      profileLoading: false,
      profileError: null,
      refreshProfile: () => {},
    };
  }
  return ctx;
}

