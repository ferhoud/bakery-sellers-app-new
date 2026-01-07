// pages/index.js
import { useEffect } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let alive = true;

    const go = (path) => {
      // éviter une nav vers la même URL
      if (router.asPath !== path) {
        router.replace(path).catch(() => {}); // ⟵ on avale l'abort
      }
    };

    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data?.session?.user;

      if (!user) { go("/login"); return; }

      try {
        const { data: prof } = await supabase
          .from("profiles")
          .select("role")
          .eq("user_id", user.id)
          .single();

        if (!alive) return;

        if (prof?.role === "admin") go("/admin");
        else go("/app");
      } catch {
        go("/app");
      }
    })();

    return () => { alive = false; };
  }, [router]);

  return <div style={{ padding: 20, fontFamily: "system-ui" }}>Redirection…</div>;
}
