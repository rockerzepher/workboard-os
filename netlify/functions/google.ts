import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

type GoogleSession = {
  state?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type GoogleTaskList = { id: string; title: string };
type GoogleTask = { id: string; title?: string; due?: string; status?: string; notes?: string };

const sessions = getStore({ name: "workboard-google-sessions", consistency: "strong" });
const SESSION_COOKIE = "workboard-google-session";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";

function cookieValue(cookieHeader: string | null, name: string) {
  return cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function cookieHeader(sessionId: string, request: Request, maxAge = 2592000) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionId}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function readSession(sessionId: string | undefined) {
  return sessionId ? await sessions.get(`session:${sessionId}`, { type: "json" }) as GoogleSession | null : null;
}

async function fetchGoogleToken(params: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  return { response, payload };
}

async function refreshSession(sessionId: string, session: GoogleSession, clientId: string, clientSecret: string) {
  if (!session.refreshToken) return null;
  const { response, payload } = await fetchGoogleToken(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
  }));
  if (!response.ok || !payload.access_token) return null;
  const refreshed = {
    ...session,
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    refreshToken: payload.refresh_token ?? session.refreshToken,
  } satisfies GoogleSession;
  await sessions.setJSON(`session:${sessionId}`, refreshed);
  return refreshed;
}

async function validSession(sessionId: string, session: GoogleSession, clientId: string, clientSecret: string) {
  if (session.accessToken && (session.expiresAt ?? 0) > Date.now() + 60_000) return session;
  return refreshSession(sessionId, session, clientId, clientSecret);
}

async function googleJson<T>(url: string, accessToken: string) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json() as T;
  return { response, payload };
}

async function fetchAll<T>(url: string, accessToken: string) {
  const items: T[] = [];
  let pageToken = "";
  do {
    const separator = url.includes("?") ? "&" : "?";
    const pageUrl = `${url}${separator}maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const { response, payload } = await googleJson<{ items?: T[]; nextPageToken?: string }>(pageUrl, accessToken);
    if (!response.ok) throw new Error(`Google Tasks request failed (${response.status})`);
    if (Array.isArray(payload.items)) items.push(...payload.items);
    pageToken = payload.nextPageToken ?? "";
  } while (pageToken);
  return items;
}

async function readTasks(accessToken: string) {
  const lists = await fetchAll<GoogleTaskList>("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken);
  const tasks = [] as Array<{ sourceId: string; sourceKey: string; title: string; listName: string; due?: string; completed: boolean; notes?: string }>;
  for (const list of lists) {
    const records = await fetchAll<GoogleTask>(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks?showCompleted=true&showHidden=false`, accessToken);
    tasks.push(...records.map((task) => ({
      sourceId: task.id,
      sourceKey: `google_tasks:${task.id}`,
      title: task.title ?? "Untitled Google Task",
      listName: list.title,
      due: task.due?.slice(0, 10),
      completed: task.status === "completed",
      notes: task.notes,
    })));
  }
  return { accountLabel: "Connected Google Tasks account", mode: "live" as const, tasks };
}

export default async (request: Request, context: Context) => {
  const action = context.params.action;
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID") || Netlify.env.get("VITE_GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri = Netlify.env.get("GOOGLE_REDIRECT_URI") || new URL("/api/google/callback", request.url).toString();
  const configured = Boolean(clientId && clientSecret);
  const existingSessionId = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  const sessionId = existingSessionId || crypto.randomUUID();
  const session = await readSession(existingSessionId);

  if (action === "status") {
    return json({ connected: Boolean(session?.accessToken || session?.refreshToken), configured });
  }

  if (action === "start") {
    if (!clientId || !clientSecret) return json({ error: "Google server OAuth is not configured in Netlify environment variables." }, 503);
    const state = crypto.randomUUID();
    await sessions.setJSON(`session:${sessionId}`, { state });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return new Response(null, { status: 302, headers: { Location: authorizationUrl.toString(), "Set-Cookie": cookieHeader(sessionId, request, 600) } });
  }

  if (action === "callback") {
    if (!clientId || !clientSecret) return json({ error: "Google server OAuth is not configured in Netlify environment variables." }, 503);
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (!code || !state || state !== session?.state) return json({ error: "Google authorization could not be verified." }, 400);
    const { response, payload } = await fetchGoogleToken(new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }));
    if (!response.ok || !payload.access_token) return json({ error: payload.error ?? "Google token exchange failed." }, 502);
    await sessions.setJSON(`session:${sessionId}`, {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    } satisfies GoogleSession);
    return new Response(null, { status: 302, headers: { Location: "/?google=connected", "Set-Cookie": cookieHeader(sessionId, request) } });
  }

  if (action === "tasks") {
    if (!clientId || !clientSecret || !session) return json({ error: "Google Tasks is not connected." }, 401);
    let activeSession = await validSession(sessionId, session, clientId, clientSecret);
    if (!activeSession?.accessToken) return json({ error: "Google Tasks session has expired. Please reconnect Google." }, 401);
    try {
      return json(await readTasks(activeSession.accessToken));
    } catch (error) {
      if (activeSession.accessToken === session.accessToken) {
        activeSession = await refreshSession(sessionId, activeSession, clientId, clientSecret);
        if (activeSession?.accessToken) return json(await readTasks(activeSession.accessToken));
      }
      return json({ error: error instanceof Error ? error.message : "Google Tasks request failed." }, 502);
    }
  }

  return json({ error: "Google route not found." }, 404);
};

export const config: Config = { path: "/api/google/:action" };
