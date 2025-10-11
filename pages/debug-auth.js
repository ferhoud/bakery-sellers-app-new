/* eslint-disable react/no-unescaped-entities */
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function DebugAuth() {
  const [envOk, setEnvOk] = useState({ url: false, anon: false });
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [logs, setLogs] = useState([]);
  const log = (m, o) => setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${m} ${o ? JSON.stringify(o) : ""}`]);

  useEffect(() => {
    setEnvOk({
      url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      anon: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });

    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session ?? null);
      setUser(session?.user ?? null);
      log("getSession", { hasSession: !!session });

      if (session?.user?.id) {
        const { data, error } = await supabase
          .from("profiles")
          .select("user_id, full_name, role")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (error) log("profiles.select error", { error });
        setProfile(data ?? null);
      }
    };
    init();

    const { data: sub } = supabase.auth.onAuthStateChange((evt, session) => {
      log("onAuthStateChange", { evt, hasSession: !!session });
      setSession(session ?? null);
      setUser(session?.user ?? null);
    });
    return () => sub?.subscription?.unsubscribe();
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "20px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>Debug Auth</h1>
      <section style={sec}><h3>Environnement</h3>
        <div>URL: <b>{envOk.url ? "ok" : "manquant"}</b></div>
        <div>ANON: <b>{envOk.anon ? "ok" : "manquant"}</b></div>
      </section>
      <section style={sec}><h3>Session</h3><pre style={pre}>{JSON.stringify(session, null, 2)}</pre>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </section>
      <section style={sec}><h3>User</h3><pre style={pre}>{JSON.stringify(user, null, 2)}</pre></section>
      <section style={sec}><h3>Profile (table profiles)</h3><pre style={pre}>{JSON.stringify(profile, null, 2)}</pre></section>
      <section style={sec}><h3>Logs</h3><pre style={pre}>{logs.join("\n")}</pre></section>
    </div>
  );
}

const sec = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, marginTop: 16 };
const pre = { background: "#f3f4f6", padding: 12, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap" };
