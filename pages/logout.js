import { useEffect } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

export default function Logout() {
  const r = useRouter();
  useEffect(() => {
    (async () => {
      try { await supabase.auth.signOut(); } finally { r.replace("/login"); }
    })();
  }, [r]);
  return <div style={{padding:20,fontFamily:"system-ui"}}>Déconnexion…</div>;
}
