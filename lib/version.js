// /lib/version.js
export const BUILD_TAG = "ADMIN — 14/10/2025 01:45 TDZ+Absent+Repl OK";
export const COMMIT = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0,7) || "";
export const BRANCH = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF || "";
export const REPO   = process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG || "";
export const ENV    = process.env.NEXT_PUBLIC_RUNTIME_ENV || (process.env.VERCEL ? "vercel" : "local");
export default BUILD_TAG;
