// pages/_app.js
import "@/styles/globals.css"; // retire si absent
import { AuthProvider } from "@/lib/useAuth";

export default function MyApp({ Component, pageProps }) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
