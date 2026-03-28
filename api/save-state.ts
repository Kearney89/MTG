import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { password, state } = req.body ?? {};

    if (!password || password !== process.env.MTG_ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password non valida" });
    }

    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "State mancante o non valido" });
    }

    const { error } = await supabase
      .from("league_state")
      .upsert(
        {
          id: "main",
          data: state,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Errore sconosciuto",
    });
  }
}