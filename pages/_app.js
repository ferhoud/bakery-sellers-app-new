// pages/_app.js
import { useEffect } from 'react';
import '../styles/globals.css';

export default function MyApp({ Component, pageProps }) {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((r) => {
        if (!r) {
          navigator.serviceWorker.register('/sw.js').catch(() => {});
        }
      });
    }
  }, []);

  return <Component {...pageProps} />;
}
