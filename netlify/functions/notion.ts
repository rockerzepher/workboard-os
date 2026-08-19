import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

type NotionSession = { state?: string; accessToken?: string; refreshToken?: string; workspaceName?: string };
type NotionApiResult = { id: string; object: "page" | "database"; url?: string; properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>; title?: Array<{ plain_text?: string }> };

const sessions = getStore({ name: "workboard-notion-sessions", consistency: "strong" });
const SESSION_COOKIE = "workboard-notion-session";
const NOTION_API_VERSION = "2026-03-11";

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

function notionTitle(result: NotionApiResult) {
  if (result.object === "database") return result.title?.[0]?.plain_text ?? "Untitled database";
  const titleProperty = Object.values(result.properties ?? {}).find((property) => property.type === "title");
  return titleProperty?.title?.[0]?.plain_text ?? "Untitled page";
}

async function readSession(sessionId: string | undefined) {
  return sessionId ? await sessions.get(`session:${sessionId}`, { type: "json" }) as NotionSession | null : null;
}

async function notionRequest(path: string, token: string, init: RequestInit = {}) {
  return fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function refreshNotionSession(sessionId: string, session: NotionSession, clientId: string, clientSecret: string) {
  if (!session.refreshToken) return null;
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: session.refreshToken }),
  });
  const payload = await response.json() as { access_token?: string; refresh_token?: string };
  if (!response.ok || !payload.access_token) return null;
  const refreshed = { ...session, accessToken: payload.access_token, refreshToken: payload.refresh_token ?? session.refreshToken };
  await sessions.setJSON(`session:${sessionId}`, refreshed);
  return refreshed;
}

export default async (request: Request, context: Context) => {
  const action = context.params.action;
  const clientId = Netlify.env.get("NOTION_CLIENT_ID");
  const clientSecret = Netlify.env.get("NOTION_CLIENT_SECRET");
  const redirectUri = Netlify.env.get("NOTION_REDIRECT_URI") || new URL("/api/notion/callback", request.url).toString();
  const configured = Boolean(clientId && clientSecret);
  const existingSessionId = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  const sessionId = existingSessionId || crypto.randomUUID();
  const session = await readSession(existingSessionId);

  if (action === "status") return json({ connected: Boolean(session?.accessToken || session?.refreshToken), configured, workspaceName: session?.workspaceName });

  if (action === "start") {
    if (!clientId || !clientSecret) return json({ error: "Notion OAuth is not configured in Netlify environment variables." }, 503);
    const state = crypto.randomUUID();
    await sessions.setJSON(`session:${sessionId}`, { state });
    const authorizationUrl = new URL("https://api.notion.com/v1/oauth/authorize");
    authorizationUrl.search = new URLSearchParams({ owner: "user", client_id: clientId, redirect_uri: redirectUri, response_type: "code", state }).toString();
    return new Response(null, { status: 302, headers: { Location: authorizationUrl.toString(), "Set-Cookie": cookieHeader(sessionId, request, 600) } });
  }

  if (action === "callback") {
    if (!clientId || !clientSecret) return json({ error: "Notion OAuth is not configured in Netlify environment variables." }, 503);
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (!code || !state || state !== session?.state) return json({ error: "Notion authorization could not be verified." }, 400);
    const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    const tokenPayload = await tokenResponse.json() as { access_token?: string; refresh_token?: string; workspace_name?: string; error?: string };
    if (!tokenResponse.ok || !tokenPayload.access_token) return json({ error: tokenPayload.error ?? "Notion token exchange failed." }, 502);
    await sessions.setJSON(`session:${sessionId}`, { accessToken: tokenPayload.access_token, refreshToken: tokenPayload.refresh_token, workspaceName: tokenPayload.workspace_name });
    return new Response(null, { status: 302, headers: { Location: "/?notion=connected", "Set-Cookie": cookieHeader(sessionId, request) } });
  }

  if (action === "search") {
    if (!session?.accessToken && !session?.refreshToken) return json({ error: "Notion is not connected." }, 401);
    const query = new URL(request.url).searchParams.get("q") ?? "";
    let activeSession = session;
    let searchResponse = activeSession.accessToken ? await notionRequest("/search", activeSession.accessToken, { method: "POST", body: JSON.stringify({ query, page_size: 50 }) }) : new Response(null, { status: 401 });
    if (searchResponse.status === 401 && clientId && clientSecret) {
      activeSession = await refreshNotionSession(sessionId, activeSession, clientId, clientSecret) ?? activeSession;
      if (activeSession.accessToken && activeSession.accessToken !== session.accessToken) searchResponse = await notionRequest("/search", activeSession.accessToken, { method: "POST", body: JSON.stringify({ query, page_size: 50 }) });
    }
    const payload = await searchResponse.json() as { results?: NotionApiResult[]; message?: string };
    if (!searchResponse.ok) return json({ error: payload.message ?? "Notion search failed." }, searchResponse.status);
    return json({ results: (payload.results ?? []).map((result) => ({ id: result.id, title: notionTitle(result), kind: result.object, url: result.url })) });
  }

  return json({ error: "Notion route not found." }, 404);
};

export const config: Config = { path: "/api/notion/:action" };
