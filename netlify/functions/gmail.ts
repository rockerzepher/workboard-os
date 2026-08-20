import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

type GmailSession = { state?: string; accessToken?: string; refreshToken?: string; expiresAt?: number };
type GmailHeader = { name: string; value: string };
type GmailMessage = { id: string; threadId: string; internalDate?: string; snippet?: string; labelIds?: string[]; payload?: { headers?: GmailHeader[] } };
type GmailThread = { messages?: GmailMessage[] };

const sessions = getStore({ name: "workboard-gmail-sessions", consistency: "strong" });
const SESSION_COOKIE = "workboard-gmail-session";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type GmailCandidate = {
  id: string;
  threadId: string;
  kind: "sent_follow_up" | "incoming_attention";
  subject: string;
  sender: string;
  date: string;
  snippet: string;
  reason: string;
  suggestedAction: string;
  sourceUrl: string;
};

function cookieValue(cookieHeader: string | null, name: string) {
  return cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function cookieHeader(sessionId: string, request: Request, maxAge = 2592000) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionId}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function readSession(sessionId: string | undefined) {
  return sessionId ? await sessions.get(`session:${sessionId}`, { type: "json" }) as GmailSession | null : null;
}

async function tokenRequest(params: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  return { response, payload };
}

async function refreshSession(sessionId: string, session: GmailSession, clientId: string, clientSecret: string) {
  if (!session.refreshToken) return null;
  const { response, payload } = await tokenRequest(new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: session.refreshToken }));
  if (!response.ok || !payload.access_token) return null;
  const refreshed = { ...session, accessToken: payload.access_token, refreshToken: payload.refresh_token ?? session.refreshToken, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 } satisfies GmailSession;
  await sessions.setJSON(`session:${sessionId}`, refreshed);
  return refreshed;
}

async function validSession(sessionId: string, session: GmailSession, clientId: string, clientSecret: string) {
  if (session.accessToken && (session.expiresAt ?? 0) > Date.now() + 60_000) return session;
  return refreshSession(sessionId, session, clientId, clientSecret);
}

async function gmailJson<T>(path: string, accessToken: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json() as T;
  return { response, payload };
}

function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function messageDetails(message: GmailMessage) {
  return {
    subject: header(message, "Subject") || "(No subject)",
    sender: header(message, "From") || "Unknown sender",
    date: header(message, "Date") || message.internalDate || "",
  };
}

function isBulkMessage(message: GmailMessage) {
  const listUnsubscribe = header(message, "List-Unsubscribe");
  const precedence = header(message, "Precedence").toLowerCase();
  const autoSubmitted = header(message, "Auto-Submitted").toLowerCase();
  const from = header(message, "From").toLowerCase();
  return Boolean(listUnsubscribe || precedence === "bulk" || precedence === "list" || autoSubmitted === "auto-replied" || /no[-_]?reply|mailer-daemon/.test(from));
}

async function listMessages(accessToken: string, query: string, maxResults = 25) {
  const { response, payload } = await gmailJson<{ messages?: Array<{ id: string; threadId: string }> }>(`messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`, accessToken);
  if (!response.ok) throw new Error(`Gmail request failed (${response.status})`);
  const messages: GmailMessage[] = [];
  for (const item of payload.messages ?? []) {
    const details = await gmailJson<GmailMessage>(`messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence&metadataHeaders=Auto-Submitted`, accessToken);
    if (details.response.ok) messages.push(details.payload);
  }
  return messages;
}

async function scanMailbox(accessToken: string) {
  const profile = await gmailJson<{ emailAddress?: string }>("profile", accessToken);
  if (!profile.response.ok) throw new Error(`Gmail profile could not be read (${profile.response.status})`);
  const sent = await listMessages(accessToken, "in:sent newer_than:7d", 30);
  const incoming = await listMessages(accessToken, "in:inbox newer_than:7d -category:promotions -category:social -category:updates -category:forums", 30);
  const candidates: GmailCandidate[] = [];

  for (const message of sent) {
    const thread = await gmailJson<GmailThread>(`threads/${message.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Date`, accessToken);
    if (!thread.response.ok) continue;
    const threadMessages = thread.payload.messages ?? [];
    const latest = [...threadMessages].sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))[0];
    if (!latest || header(latest, "From").toLowerCase().includes((profile.payload.emailAddress ?? "").toLowerCase()) || threadMessages.length === 1) {
      const details = messageDetails(message);
      candidates.push({ id: message.id, threadId: message.threadId, kind: "sent_follow_up", ...details, snippet: message.snippet ?? "", reason: "Sent in the past seven days with no clear newer reply in the thread.", suggestedAction: "Decide whether to follow up, wait, or close the loop.", sourceUrl: `https://mail.google.com/mail/u/0/#all/${message.threadId}` });
    }
  }

  for (const message of incoming) {
    if (isBulkMessage(message)) continue;
    const details = messageDetails(message);
    candidates.push({ id: message.id, threadId: message.threadId, kind: "incoming_attention", ...details, snippet: message.snippet ?? "", reason: "Recent incoming message that is not classified as marketing, social, or bulk mail.", suggestedAction: "Review and decide whether it needs a WorkBoard action.", sourceUrl: `https://mail.google.com/mail/u/0/#all/${message.threadId}` });
  }

  return { accountLabel: profile.payload.emailAddress ? `Gmail · ${profile.payload.emailAddress}` : "Connected Gmail account", mode: "live" as const, scannedDays: 7, scannedAt: new Date().toISOString(), candidates: candidates.slice(0, 40) };
}

export default async (request: Request, context: Context) => {
  const action = context.params.action;
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID") || Netlify.env.get("VITE_GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri = Netlify.env.get("GMAIL_REDIRECT_URI") || new URL("/api/gmail/callback", request.url).toString();
  const configured = Boolean(clientId && clientSecret);
  const existingSessionId = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  const sessionId = existingSessionId || crypto.randomUUID();
  const session = await readSession(existingSessionId);

  if (action === "status") return json({ connected: Boolean(session?.accessToken || session?.refreshToken), configured });
  if (action === "start") {
    if (!clientId || !clientSecret) return json({ error: "Gmail is not configured in Netlify environment variables." }, 503);
    const state = crypto.randomUUID();
    await sessions.setJSON(`session:${sessionId}`, { state });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: session?.refreshToken ? "select_account" : "consent", state }).toString();
    return new Response(null, { status: 302, headers: { Location: authorizationUrl.toString(), "Set-Cookie": cookieHeader(sessionId, request, 600) } });
  }
  if (action === "callback") {
    if (!clientId || !clientSecret) return json({ error: "Gmail is not configured in Netlify environment variables." }, 503);
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (!code || !state || state !== session?.state) return json({ error: "Gmail authorization could not be verified." }, 400);
    const { response, payload } = await tokenRequest(new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }));
    if (!response.ok || !payload.access_token) return json({ error: payload.error ?? "Gmail token exchange failed." }, 502);
    await sessions.setJSON(`session:${sessionId}`, { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 } satisfies GmailSession);
    return new Response(null, { status: 302, headers: { Location: "/?gmail=connected", "Set-Cookie": cookieHeader(sessionId, request) } });
  }
  if (action === "scan") {
    if (!clientId || !clientSecret || !session) return json({ error: "Gmail is not connected." }, 401);
    let activeSession = await validSession(sessionId, session, clientId, clientSecret);
    if (!activeSession?.accessToken) return json({ error: "Gmail session has expired. Please reconnect Gmail." }, 401);
    try {
      return json(await scanMailbox(activeSession.accessToken));
    } catch (error) {
      if (activeSession.accessToken === session.accessToken) {
        activeSession = await refreshSession(sessionId, activeSession, clientId, clientSecret);
        if (activeSession?.accessToken) return json(await scanMailbox(activeSession.accessToken));
      }
      return json({ error: error instanceof Error ? error.message : "Gmail scan failed." }, 502);
    }
  }
  return json({ error: "Gmail route not found." }, 404);
};

export const config: Config = { path: "/api/gmail/:action" };
