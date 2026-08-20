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

export type GmailScan = {
  accountLabel: string;
  mode: "live";
  scannedDays: number;
  scannedAt: string;
  candidates: GmailCandidate[];
};

export type GmailConnectionStatus = { connected: boolean; configured: boolean };

async function readJson<T>(path: string) {
  const response = await fetch(path, { credentials: "include" });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Gmail request failed");
  return payload;
}

export async function getGmailStatus() {
  return readJson<GmailConnectionStatus>("/api/gmail/status");
}

export function startGmailOAuth() {
  window.location.assign("/api/gmail/start");
}

export async function scanGmail() {
  return readJson<GmailScan>("/api/gmail/scan");
}
