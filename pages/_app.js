// pages/_app.js
import "@/styles/globals.css"; // supprime si tu n'as pas ce fichier
import { AuthProvider } from "@/lib/useAuth";

export default function MyApp({ Component, pageProps }) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
