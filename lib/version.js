// /lib/version.js

function shortCommit(sha) {
  if (!sha) return "";
  return String(sha).slice(0, 7);
}

export function getBuildInfo() {
  // Vercel fournit ces variables automatiquement sur les builds
  const env =
    process.env.VERCEL_ENV ||
    (process.env.NODE_ENV === "production" ? "production" : "development");

  const commitFull =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    "";

  const branch =
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF ||
    process.env.GIT_BRANCH ||
    "";

  const repo =
    process.env.VERCEL_GIT_REPO_SLUG ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG ||
    process.env.REPO ||
    "";

  const commit = shortCommit(commitFull);

  // Si tu veux forcer un texte précis, tu peux définir NEXT_PUBLIC_BUILD_TAG dans Vercel.
  const forcedTag = process.env.NEXT_PUBLIC_BUILD_TAG || process.env.BUILD_TAG || "";

  const envLabel =
    env === "production" ? "PROD" : env === "preview" ? "PREVIEW" : "DEV";

  const buildTag =
    forcedTag ||
    [envLabel, commit ? commit : null, branch ? branch : null].filter(Boolean).join(" ");

  return { buildTag, commit, branch, repo, env };
}

// Compat avec ton usage existant (BUILD_TAG centralisé)
export const BUILD_TAG = getBuildInfo().buildTag;
