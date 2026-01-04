// /lib/version.js

function shortCommit(sha) {
  if (!sha) return "";
  return String(sha).slice(0, 7);
}

export function getBuildInfo() {
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

  // Ton libellé "humain"
  const label = process.env.NEXT_PUBLIC_APP_LABEL || "Vente Rambouillet";
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "v1.0";

  // Suffixe auto qui change à chaque déploiement
  const suffix = commit ? `• ${commit}` : branch ? `• ${branch}` : "";

  const buildTag = [label, appVersion, suffix].filter(Boolean).join(" ").trim();

  return { buildTag, commit, branch, repo, env };
}

// Compat avec l’existant
export const BUILD_TAG = getBuildInfo().buildTag;
