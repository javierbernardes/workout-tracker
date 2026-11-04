// =====================================================
//  DELETE ACCOUNT (a Supabase Edge Function)
//  Called by the app when someone taps "Delete my account" in Profile.
//  It checks who is asking (their sign-in pass must be valid), then deletes
//  that account. The database removes everything attached to it at the same
//  time: logs, membership row, reminder subscriptions.
//
//  Only the person themself can delete their account: the pass in the
//  request decides which account goes, nothing in the body can choose another.
// =====================================================

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405, headers: CORS });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Not signed in" }, { status: 401, headers: CORS });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Whose pass is this?
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who?.user) return Response.json({ error: "Please sign in again" }, { status: 401, headers: CORS });

  // The admin account is protected from deleting itself by accident
  const { data: member } = await admin.from("members").select("role").eq("user_id", who.user.id).maybeSingle();
  if (member?.role === "admin") {
    return Response.json({ error: "The admin account can't be deleted from the app" }, { status: 403, headers: CORS });
  }

  const { error } = await admin.auth.admin.deleteUser(who.user.id);
  if (error) return Response.json({ error: error.message }, { status: 500, headers: CORS });
  return Response.json({ ok: true }, { headers: CORS });
});
