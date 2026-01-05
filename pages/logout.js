/* eslint-disable react/no-unescaped-entities */

import { useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Logout() {
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        await supabase.auth.signOut();
      } catch (_) {}

      if (!alive || typeof window === "undefined") return;

      try {
        const ls = window.localStorage;
        const ss = window.sessionStorage;

        const collectKeys = (st) => {
          const out = [];
          try {
            for (let i = 0; i < st.length; i++) {
              const k = st.key(i);
              if (k) out.push(k);
            }
          } catch (_) {}
          return out;
        };

        const shouldRemove = (k) =>
          k.startsWith("sb-") ||
          k.includes("supabase") ||
          k.includes("auth-token") ||
          k.includes("token") ||
          k.includes("refresh");

        collectKeys(ls).forEach((k) => {
          if (shouldRemove(k)) ls.removeItem(k);
        });
        collectKeys(ss).forEach((k) => {
          if (shouldRemove(k)) ss.removeItem(k);
        });
      } catch (_) {}

      window.location.replace("/login?stay=1&next=/app");
    })();

    return () => {
      alive = false;
    };
  }, []);

  return <div className="p-4">Déconnexion...</div>;
}
