// pages/_app.js
import "@/styles/globals.css"; // si tu as un globals.css, sinon retire cette ligne
import { AuthProvider } from "@/lib/useAuth";

export default function MyApp({ Component, pageProps }) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
