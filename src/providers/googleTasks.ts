export type GoogleTaskRecord = {
  sourceId: string;
  sourceKey: string;
  title: string;
  listName: string;
  due?: string;
  completed: boolean;
  notes?: string;
};

export type GoogleTasksPreview = {
  accountLabel: string;
  mode: "demo" | "live";
  tasks: GoogleTaskRecord[];
};

export interface GoogleTasksAdapter {
  preview(): Promise<GoogleTasksPreview>;
}

type GoogleTokenResponse = { access_token?: string; error?: string; error_description?: string };
type GoogleTokenClient = { requestAccessToken: () => void };

const GOOGLE_AUTH_TIMEOUT_MS = 15000;

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (options: { client_id: string; scope: string; callback: (response: GoogleTokenResponse) => void }) => GoogleTokenClient;
        };
      };
    };
  }
}

export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";

function loadGoogleIdentityServices() {
  if (window.google?.accounts.oauth2) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const timeout = window.setTimeout(() => finish(new Error("Google authorization could not load. Try again in a regular browser window.")), 8000);
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => window.google?.accounts.oauth2 ? finish() : finish(new Error("Google Identity Services loaded without authorization support")), { once: true });
      existing.addEventListener("error", () => finish(new Error("Google Identity Services failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => window.google?.accounts.oauth2 ? finish() : finish(new Error("Google Identity Services loaded without authorization support"));
    script.onerror = () => finish(new Error("Google Identity Services failed to load"));
    document.head.appendChild(script);
  });
}

async function fetchGoogleJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google Tasks request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function fetchAll<Item>(url: string, accessToken: string) {
  const items: Item[] = [];
  let pageToken = "";
  do {
    const separator = url.includes("?") ? "&" : "?";
    const page = await fetchGoogleJson<{ items?: Item[]; nextPageToken?: string }>(`${url}${separator}maxResults=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, accessToken);
    if (Array.isArray(page.items)) items.push(...page.items);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return items;
}

type GoogleTaskListResponse = { items?: Array<{ id: string; title: string }>; nextPageToken?: string };
type GoogleTaskResponse = { items?: Array<{ id: string; title?: string; due?: string; status?: string; notes?: string }>; nextPageToken?: string };

export async function authorizeAndReadGoogleTasks(clientId: string): Promise<GoogleTasksPreview> {
  if (!clientId) throw new Error("Missing VITE_GOOGLE_CLIENT_ID");
  await loadGoogleIdentityServices();
  const accessToken = await new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Google authorization is taking too long. Try again in a regular browser window.")), GOOGLE_AUTH_TIMEOUT_MS);
    const finish = (callback: () => void) => {
      window.clearTimeout(timeout);
      callback();
    };
    const client = window.google?.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_TASKS_SCOPE,
      callback: (response) => response.access_token
        ? finish(() => resolve(response.access_token as string))
        : finish(() => reject(new Error(response.error_description ?? response.error ?? "Google authorization was not completed"))),
    });
    if (!client) finish(() => reject(new Error("Google Identity Services is unavailable")));
    else client.requestAccessToken();
  });
  const lists = await fetchAll<{ id: string; title: string }>("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken);
  const records: GoogleTaskRecord[] = [];
  for (const list of lists) {
    const tasks = await fetchAll<{ id: string; title?: string; due?: string; status?: string; notes?: string }>(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks?showCompleted=true&showHidden=false`, accessToken);
    records.push(...tasks.map((task) => ({
      sourceId: task.id,
      sourceKey: `google_tasks:${task.id}`,
      title: task.title ?? "Untitled Google Task",
      listName: list.title,
      due: task.due?.slice(0, 10),
      completed: task.status === "completed",
      notes: task.notes,
    })));
  }
  return { accountLabel: "Connected Google Tasks account", mode: "live", tasks: records };
}

const syntheticTasks: GoogleTaskRecord[] = [
  { sourceId: "demo-gt-001", sourceKey: "google_tasks:demo-gt-001", title: "Confirm board meeting date with HM team", listName: "Planning Repository", completed: false, notes: "Synthetic dry-run record." },
  { sourceId: "demo-gt-002", sourceKey: "google_tasks:demo-gt-002", title: "Finalize Q3 Budget Proposal", listName: "This Week", due: "2026-08-19", completed: false, notes: "Synthetic dry-run record." },
  { sourceId: "demo-gt-003", sourceKey: "google_tasks:demo-gt-003", title: "Review Grant Application Draft", listName: "This Week", due: "2026-08-20", completed: false, notes: "Synthetic dry-run record." },
  { sourceId: "demo-gt-004", sourceKey: "google_tasks:demo-gt-004", title: "Renew software licenses", listName: "This Week", due: "2026-08-22", completed: true, notes: "Synthetic dry-run record." },
];

export const syntheticGoogleTasksAdapter: GoogleTasksAdapter = {
  async preview() {
    return {
      accountLabel: "Synthetic Google Tasks account",
      mode: "demo",
      tasks: syntheticTasks.map((task) => ({ ...task })),
    };
  },
};
