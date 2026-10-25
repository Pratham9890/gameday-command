// Hosted /api/briefing: there is no on-device model here, so every briefing is the
// server's own template, the same one it answers with whenever `fm serve` is down.
import { templateBriefing } from '../server/src/briefing.ts';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.status(200).json(templateBriefing(req.body));
}
