// lib/useAuth.js
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

const AuthContext = createContext({
  session: null,
  profile: null,
  loading: true,
  refreshProfile: async () => {},
  hardReset: () => {},
});

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const currentUserIdRef = useRef(null);
  const profileLoadTokenRef = useRef(0);

  const fetchProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null);
      return;
    }
    const token = ++profileLoadTokenRef.current;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, role, active")
        .eq("user_id", userId)
        .single();

      // Réponse obsolète ? On ignore.
      if (profileLoadTokenRef.current !== token) return;

      if (error) {
        console.warn("[useAuth] profile load error:", error);
        setProfile(null);
        return;
      }
      setProfile(data || null);
    } catch (e) {
      if (profileLoadTokenRef.current !== token) return;
      console.warn("[useAuth] profile load threw:", e);
      setProfile(null);
    }
  }, []);

  const hardReset = useCallback(() => {
    currentUserIdRef.current = null;
    profileLoadTokenRef.current++;
    setProfile(null);
    setSession(null);
  }, []);

  // Initial
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase.auth.getSession();
      if (cancelled) return;

      const s = error ? null : (data?.session || null);
      setSession(s);

      const uid = s?.user?.id || null;
      currentUserIdRef.current = uid;

      await fetchProfile(uid);
      if (!cancelled) setLoading(false); // ✅ on sort toujours du chargement
    })();
    return () => { cancelled = true; };
  }, [fetchProfile]);

  // Changement d’auth
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      const newUid = newSession?.user?.id || null;
      const oldUid = currentUserIdRef.current;

      setSession(newSession || null);

      if (newUid !== oldUid) {
        currentUserIdRef.current = newUid;

        if (!newUid) {
          setProfile(null); // déconnexion
          return;
        }

        setLoading(true);
        await fetchProfile(newUid);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [fetchProfile]);

  const refreshProfile = useCallback(async () => {
    const uid = currentUserIdRef.current || session?.user?.id || null;
    setLoading(true);
    await fetchProfile(uid);
    setLoading(false);
  }, [fetchProfile, session]);

  const value = useMemo(() => ({
    session,
    profile,
    loading,
    refreshProfile,
    hardReset,
  }), [session, profile, loading, refreshProfile, hardReset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
