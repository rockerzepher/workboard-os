export type NotionConnectionStatus = {
  connected: boolean;
  configured: boolean;
  workspaceName?: string;
};

export type NotionReference = {
  id: string;
  title: string;
  kind: "page" | "database";
  url?: string;
};

export async function getNotionStatus(): Promise<NotionConnectionStatus> {
  const response = await fetch("/api/notion/status");
  if (!response.ok) throw new Error("Notion status could not be loaded");
  return response.json() as Promise<NotionConnectionStatus>;
}

export async function searchNotion(query: string): Promise<NotionReference[]> {
  const response = await fetch(`/api/notion/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error("Notion search failed");
  const payload = await response.json() as { results?: NotionReference[] };
  return payload.results ?? [];
}

export function startNotionOAuth() {
  window.location.assign("/api/notion/start");
}
