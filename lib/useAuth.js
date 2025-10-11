// lib/useAuth.js
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

const AuthContext = createContext({
  session: null,
  profile: null,
  loading: true,
  refreshProfile: async () => {},
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
    // Empêche les courses: si une nouvelle requête part, on invalide l'ancienne
    const token = ++profileLoadTokenRef.current;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, role, active")
        .eq("user_id", userId)
        .single();

      if (profileLoadTokenRef.current !== token) return; // réponse obsolète

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
    // Réinitialise tout (utile après signOut)
    currentUserIdRef.current = null;
    profileLoadTokenRef.current++;
    setProfile(null);
    setSession(null);
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const s = data?.session || null;
      setSession(s);
      const uid = s?.user?.id || null;
      currentUserIdRef.current = uid;
      await fetchProfile(uid);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchProfile]);

  // Écoute tous les changements d’auth (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESH, USER_UPDATED)
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      const newUid = newSession?.user?.id || null;
      const oldUid = currentUserIdRef.current;

      setSession(newSession || null);

      // Si l’utilisateur a changé (ou s’est déconnecté), on refetch le profil
      if (newUid !== oldUid) {
        currentUserIdRef.current = newUid;

        if (!newUid) {
          // Déconnexion → purge propre
          setProfile(null);
          return;
        }

        // Connexion / switch de compte → recharger le profil du NOUVEL utilisateur
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
    hardReset, // exposé si tu veux l'appeler après un signOut très agressif
  }), [session, profile, loading, refreshProfile, hardReset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
