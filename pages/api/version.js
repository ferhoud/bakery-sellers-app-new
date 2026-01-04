// /pages/api/version.js
import { getBuildInfo } from "../../lib/version";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json(getBuildInfo());
}
