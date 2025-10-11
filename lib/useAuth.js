// lib/useAuth.js — version safe du fetchProfile (remplace-la)
const fetchProfile = useCallback(async (userId) => {
  if (!userId) { setProfile(null); return; }
  const token = ++profileLoadTokenRef.current;

  // 1) RPC securisée (créée plus tôt) — passe RLS et ne récursive pas
  try {
    const { data: rows, error: rpcErr } = await supabase.rpc("get_my_profile");
    if (profileLoadTokenRef.current !== token) return;
    if (!rpcErr && Array.isArray(rows) && rows.length === 1) {
      setProfile(rows[0]);
      return;
    }
  } catch {
    /* ignore */
  }

  // 2) (Optionnel) Fallback direct désactivé pour l’instant pour éviter les policies
  // try {
  //   const { data, error } = await supabase
  //     .from("profiles")
  //     .select("user_id, full_name, role, active")
  //     .eq("user_id", userId)
  //     .single();
  //   if (profileLoadTokenRef.current !== token) return;
  //   if (error) { setProfile(null); return; }
  //   setProfile(data || null);
  // } catch { setProfile(null); }
}, []);
