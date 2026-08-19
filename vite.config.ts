import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

declare const process: { cwd: () => string };

type NotionSession = { state?: string; accessToken?: string; workspaceName?: string };

const notionSessions = new Map<string, NotionSession>();
const NOTION_SESSION_COOKIE = "workboard-notion-session";
const NOTION_API_VERSION = "2026-03-11";

function cookieValue(cookieHeader: string | undefined, name: string) {
  return cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sessionCookie(sessionId: string) {
  return `${NOTION_SESSION_COOKIE}=${sessionId}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax`;
}

function jsonResponse(response: any, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function notionTitle(result: any) {
  if (result.object === "database") return result.title?.[0]?.plain_text ?? "Untitled database";
  const titleProperty = Object.values(result.properties ?? {}).find((property: any) => property.type === "title") as any;
  return titleProperty?.title?.[0]?.plain_text ?? "Untitled page";
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

function notionDevServer(env: Record<string, string>): Plugin {
  const clientId = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;
  const redirectUri = env.NOTION_REDIRECT_URI || "http://127.0.0.1:5173/api/notion/callback";

  return {
    name: "workboard-notion-oauth",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrlValue = (request as any).url as string | undefined;
        if (!requestUrlValue?.startsWith("/api/notion/")) {
          next();
          return;
        }
        void (async () => {
          const requestUrl = new URL(requestUrlValue!, "http://127.0.0.1:5173");
          const sessionId = cookieValue((request as any).headers?.cookie, NOTION_SESSION_COOKIE) ?? crypto.randomUUID();
          const session = notionSessions.get(sessionId) ?? {};
          const configured = Boolean(clientId && clientSecret);

          if (requestUrl.pathname === "/api/notion/status") {
            jsonResponse(response, 200, { connected: Boolean(session.accessToken), configured, workspaceName: session.workspaceName });
            return;
          }

          if (requestUrl.pathname === "/api/notion/start") {
            if (!configured) {
              jsonResponse(response, 503, { error: "Notion OAuth is not configured. Add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET to .env.local." });
              return;
            }
            const state = crypto.randomUUID();
            notionSessions.set(sessionId, { state });
            const authorizationUrl = new URL("https://api.notion.com/v1/oauth/authorize");
            authorizationUrl.search = new URLSearchParams({ owner: "user", client_id: clientId, redirect_uri: redirectUri, response_type: "code", state }).toString();
            response.statusCode = 302;
            response.setHeader("Location", authorizationUrl.toString());
            response.setHeader("Set-Cookie", sessionCookie(sessionId));
            response.end();
            return;
          }

          if (requestUrl.pathname === "/api/notion/callback") {
            const code = requestUrl.searchParams.get("code");
            const state = requestUrl.searchParams.get("state");
            if (!code || !state || state !== session.state) {
              jsonResponse(response, 400, { error: "Notion authorization could not be verified." });
              return;
            }
            const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
              method: "POST",
              headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
              body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
            });
            const tokenPayload = await tokenResponse.json() as { access_token?: string; workspace_name?: string; error?: string };
            if (!tokenResponse.ok || !tokenPayload.access_token) {
              jsonResponse(response, 502, { error: tokenPayload.error ?? "Notion token exchange failed." });
              return;
            }
            notionSessions.set(sessionId, { accessToken: tokenPayload.access_token, workspaceName: tokenPayload.workspace_name });
            response.statusCode = 302;
            response.setHeader("Location", "/?notion=connected");
            response.setHeader("Set-Cookie", sessionCookie(sessionId));
            response.end();
            return;
          }

          if (requestUrl.pathname === "/api/notion/search") {
            if (!session.accessToken) {
              jsonResponse(response, 401, { error: "Notion is not connected." });
              return;
            }
            const searchResponse = await notionRequest("/search", session.accessToken, { method: "POST", body: JSON.stringify({ query: requestUrl.searchParams.get("q") ?? "", page_size: 50 }) });
            const payload = await searchResponse.json() as { results?: any[]; message?: string };
            if (!searchResponse.ok) {
              jsonResponse(response, searchResponse.status, { error: payload.message ?? "Notion search failed." });
              return;
            }
            const results = (payload.results ?? []).map((result) => ({ id: result.id, title: notionTitle(result), kind: result.object === "database" ? "database" : "page", url: result.url }));
            jsonResponse(response, 200, { results });
            return;
          }

          next();
        })().catch((error) => jsonResponse(response, 500, { error: error instanceof Error ? error.message : "Notion request failed." }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [react(), notionDevServer(env)] };
});
