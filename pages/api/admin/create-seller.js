export default function handler(_req, res) {
  res.status(501).json({ error: "create-seller disabled temporarily (conflict cleanup)" });
}
