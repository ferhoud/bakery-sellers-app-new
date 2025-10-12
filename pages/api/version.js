// /pages/api/version.js
import { BUILD_TAG } from "@/lib/version";

export default function handler(req, res) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  res.status(200).json({
    buildTag: BUILD_TAG,
    commit: sha ? sha.slice(0, 7) : "dev",
    branch: process.env.VERCEL_GIT_COMMIT_REF || "",
    repo: process.env.VERCEL_GIT_REPO_SLUG || "",
    env: process.env.VERCEL_ENV || "local"
  });
}
