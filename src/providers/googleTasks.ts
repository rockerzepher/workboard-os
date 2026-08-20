export type GoogleTaskRecord = {
  sourceId: string;
  sourceKey: string;
  title: string;
  listName: string;
  parentSourceId?: string;
  due?: string;
  completed: boolean;
  notes?: string;
};

export type GoogleTasksPreview = {
  accountLabel: string;
  mode: "demo" | "live";
  tasks: GoogleTaskRecord[];
};

export type GoogleConnectionStatus = {
  connected: boolean;
  configured: boolean;
};

export interface GoogleTasksAdapter {
  preview(): Promise<GoogleTasksPreview>;
}

async function readJson<T>(path: string) {
  const response = await fetch(path, { credentials: "include" });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Google Tasks request failed");
  return payload;
}

export async function getGoogleStatus() {
  return readJson<GoogleConnectionStatus>("/api/google/status");
}

export function startGoogleOAuth() {
  window.location.assign("/api/google/start");
}

export async function readConnectedGoogleTasks() {
  return readJson<GoogleTasksPreview>("/api/google/tasks");
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
