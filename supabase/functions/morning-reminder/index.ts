// =====================================================
//  MORNING REMINDER (a Supabase Edge Function)
//  Runs every 5 minutes (started by a timer in the database).
//  For each phone that turned the reminder on: if it's that person's chosen
//  time (in their own time zone) and they haven't had today's reminder yet,
//  send "Daily wake-up & weigh-in". Skipped if they already did both today.
//
//  Safe to call by anyone: it only ever sends due reminders, once a day.
//  GET                    -> the public notification key (the app needs it)
//  POST {}                -> send any reminders that are due
//  POST {"test": "<url>"} -> one test reminder to that subscribed phone
//  POST {"joined": "<user id>"} -> tell the admin's phone(s) that someone asked to join
//                            (fired by the database when a new member row appears;
//                            only works for accounts created in the last 10 minutes)
//  POST {"challenge_started": "<id>"} -> everyone: "New challenge: …"
//  POST {"challenge_closed": "<id>"}  -> each participant: how they finished
//  POST {"overtaken": "<user id>", "title": "…", "rank": n} -> that person: dropped out of the top 3
//  (the last three are fired by the database; each can only send once per challenge/day)
// =====================================================

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SITE = "https://javierbernardes.github.io/workout-tracker/";
const MESSAGE = JSON.stringify({
  title: "Good morning ☀️",
  body: "Daily wake-up & weigh-in: tap to log them.",
});

// Let the website (on any address) talk to this program
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
};

// The app's notification keys; made the very first time and kept in push_config
async function getKeys() {
  const { data } = await supabase.from("push_config").select("public_key, private_key").eq("id", 1).maybeSingle();
  if (data) return data;
  const keys = webpush.generateVAPIDKeys();
  const row = { id: 1, public_key: keys.publicKey, private_key: keys.privateKey };
  const { error } = await supabase.from("push_config").insert(row);
  if (error) throw error;
  return row;
}

// Today's date and the minutes since midnight in someone's time zone
function localNow(timeZone: string): { date: string; minutes: number } {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
  } catch {
    return localNow("UTC");
  }
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function send(sub: { endpoint: string; p256dh: string; auth: string }, message = MESSAGE) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      message,
    );
    return true;
  } catch (err) {
    // The phone unsubscribed or the app was removed: forget it
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    }
    console.error("send failed", status);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const keys = await getKeys();
  if (req.method === "GET") return Response.json({ publicKey: keys.public_key }, { headers: CORS });
  webpush.setVapidDetails(SITE, keys.public_key, keys.private_key);

  let body: { test?: string; joined?: string; challenge_started?: string; challenge_closed?: string;
              overtaken?: string; title?: string; rank?: number } = {};
  try { body = await req.json(); } catch { /* the timer sends an empty body */ }

  // Push one message to every phone of a list of people
  async function pushTo(userIds: string[], title: string, text: string) {
    if (!userIds.length) return 0;
    const { data: subs } = await supabase.from("push_subscriptions").select("*").in("user_id", userIds);
    const message = JSON.stringify({ title, body: text });
    let sent = 0;
    for (const sub of subs ?? []) if (await send(sub, message)) sent++;
    return sent;
  }

  // A new challenge: tell everyone who is approved
  if (body.challenge_started) {
    const { data: c } = await supabase.from("challenges").select("*").eq("id", body.challenge_started).maybeSingle();
    if (!c || c.closed) return Response.json({ ok: false }, { headers: CORS });
    const { data: people } = await supabase.from("members").select("user_id").eq("status", "approved");
    const sent = await pushTo((people ?? []).map((m) => m.user_id),
      c.period === "week" ? "New challenge this week" : "New challenge this month",
      `${c.title}. Open Friends to see the ranking.`);
    return Response.json({ ok: true, sent }, { headers: CORS });
  }

  // A challenge ended: tell each participant how they finished
  if (body.challenge_closed) {
    const { data: c } = await supabase.from("challenges").select("*").eq("id", body.challenge_closed).maybeSingle();
    const { data: rows } = await supabase.from("challenge_results").select("user_id, rank, score, points").eq("challenge_id", body.challenge_closed);
    if (!c || !rows) return Response.json({ ok: false }, { headers: CORS });
    const winner = rows.find((r) => r.rank === 1 && Number(r.score) > 0);
    let winnerName = "Nobody";
    if (winner) {
      const { data: w } = await supabase.from("members").select("name").eq("user_id", winner.user_id).maybeSingle();
      winnerName = w?.name ?? winnerName;
    }
    let sent = 0;
    for (const r of rows) {
      const you = Number(r.score) > 0 ? `You finished ${ordinal(r.rank)} (+${r.points} pts).` : "You didn't score this time.";
      sent += await pushTo([r.user_id], `${c.title}: ${winnerName} won`, you);
    }
    return Response.json({ ok: true, sent }, { headers: CORS });
  }

  // Someone slid out of the top 3 (the database only asks once a day per person)
  if (body.overtaken) {
    const sent = await pushTo([body.overtaken], "You've been overtaken",
      `${body.title ?? "This challenge"}: you're now ${ordinal(body.rank ?? 4)}. Time to log something?`);
    return Response.json({ ok: true, sent }, { headers: CORS });
  }

  // Someone created an account: ping every phone of every admin
  if (body.joined) {
    const { data: who } = await supabase.from("members").select("name, status, requested_at")
      .eq("user_id", body.joined).maybeSingle();
    const fresh = who && Date.now() - new Date(who.requested_at).getTime() < 10 * 60 * 1000;
    if (!who || who.status !== "pending" || !fresh) return Response.json({ ok: false }, { headers: CORS });
    const { data: admins } = await supabase.from("members").select("user_id").eq("role", "admin").eq("status", "approved");
    const ids = (admins ?? []).map((a) => a.user_id);
    const { data: subs } = await supabase.from("push_subscriptions").select("*").in("user_id", ids);
    const message = JSON.stringify({
      title: "Someone wants to join",
      body: `${who.name || "A new person"} created an account. Open Profile → Members to approve.`,
    });
    let sent = 0;
    for (const sub of subs ?? []) if (await send(sub, message)) sent++;
    return Response.json({ ok: true, sent }, { headers: CORS });
  }

  // Test: send right now to one phone that has the reminder turned on
  if (body.test) {
    const { data: sub } = await supabase.from("push_subscriptions").select("*").eq("endpoint", body.test).maybeSingle();
    const ok = sub ? await send(sub) : false;
    return Response.json({ ok, test: true }, { headers: CORS });
  }

  const { data: subs } = await supabase.from("push_subscriptions").select("*");
  let sent = 0;
  for (const sub of subs ?? []) {
    const now = localNow(sub.time_zone);
    const [h, m] = sub.notify_time.split(":").map(Number);
    const due = h * 60 + m;
    // Not yet time, already sent today, or more than 3 hours late: skip
    if (sub.last_sent_on === now.date || now.minutes < due || now.minutes > due + 180) continue;

    await supabase.from("push_subscriptions").update({ last_sent_on: now.date }).eq("endpoint", sub.endpoint);

    // Already logged both today? Then no reminder is needed
    const { data: done } = await supabase.from("entries").select("type, data")
      .eq("user_id", sub.user_id).eq("date", now.date).in("type", ["wake", "bodyweight"]);
    const woke = (done ?? []).some((r) => r.type === "wake");
    const weighed = (done ?? []).some((r) => r.type === "bodyweight" && r.data?.morning !== false);
    if (woke && weighed) continue;

    if (await send(sub)) sent++;
  }
  return Response.json({ ok: true, checked: (subs ?? []).length, sent }, { headers: CORS });
});
