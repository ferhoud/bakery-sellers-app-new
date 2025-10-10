// pages/logout.js
import { useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Logout() {
  useEffect(() => {
    (async () => {
      try { await supabase.auth.signOut(); } catch {}
      window.location.replace("/login");
    })();
  }, []);

  return (
    <div style={{padding:24, textAlign:"center"}}>
      Déconnexion…
    </div>
  );
}
