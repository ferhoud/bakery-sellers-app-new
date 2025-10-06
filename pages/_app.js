
import "@/styles/globals.css";
import { useEffect } from "react";
import { useAuth } from "@/lib/useAuth";

export default function App({ Component, pageProps }){
  const { init } = useAuth();
  useEffect(()=>{ init(); }, [init]);
  return <Component {...pageProps} />;
}
