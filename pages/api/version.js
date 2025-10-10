export default function handler(req, res) {
  res.status(200).json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
    branch: process.env.VERCEL_GIT_COMMIT_REF || "",
    repo: process.env.VERCEL_GIT_REPO_SLUG || "",
    env: process.env.VERCEL_ENV || "local"
  });
}

