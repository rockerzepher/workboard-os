import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  Archive,
  ArrowRight,
  Bell,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Inbox,
  KanbanSquare,
  Lightbulb,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Target,
  Timer,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { loadObsidianVaultHandle, readObsidianDirectory, readObsidianVault, removeObsidianVaultHandle, saveObsidianVaultHandle, type ObsidianDirectoryHandle, type ObsidianVaultPreview } from "./providers/obsidian";
import { getGoogleStatus, readConnectedGoogleTasks, startGoogleOAuth, syntheticGoogleTasksAdapter, type GoogleTaskRecord, type GoogleTasksPreview } from "./providers/googleTasks";
import { getGmailStatus, scanGmail, startGmailOAuth, type GmailCandidate, type GmailScan } from "./providers/gmail";
import { getNotionStatus, searchNotion, startNotionOAuth, type NotionConnectionStatus, type NotionReference } from "./providers/notion";
import { inspectWorkboard, type AttentionSignal, type AttentionStatus } from "./domain/attention";

type View = "board" | "planning_repository" | "today" | "this_week" | "projects" | "app_ideas" | "waiting_for" | "attention" | "review" | "settings";
type Container = Exclude<View, "board" | "review" | "settings" | "attention" | "projects"> | "projects";
type Role = "quick_clear" | "main_outcome" | "evening_build" | null;

type Task = {
  id: string;
  sourceKey?: string;
  title: string;
  container: Container;
  area: string;
  project?: string;
  priority: "low" | "normal" | "high";
  due?: string;
  estimate?: number;
  source: "Google Tasks" | "Obsidian" | "Manual";
  completed: boolean;
  completedAt?: string;
  notes?: string;
  successCriteria?: string[];
  googleParentId?: string;
  googleTodaySubtask?: boolean;
  role?: Role;
  waitingOn?: string;
};

type TaskEditorDraft = Pick<Task, "title" | "area" | "project" | "priority" | "due" | "estimate" | "notes" | "successCriteria" | "role">;

type Project = {
  id: string;
  name: string;
  area: string;
  outcome: string;
  status: "on track" | "at risk" | "paused";
  note: string;
};

const GOOGLE_CLIENT_ID_STORAGE_KEY = "workboard-google-client-id";
const OBSIDIAN_VAULT_STORAGE_KEY = "workboard-obsidian-vault";
const NOTION_REFERENCES_STORAGE_KEY = "workboard-notion-references";
const ATTENTION_STATUS_STORAGE_KEY = "workboard-attention-status";
const HIDDEN_GOOGLE_TASKS_STORAGE_KEY = "workboard-hidden-google-tasks";

function readGoogleClientId() {
  try {
    const localValue = localStorage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
    if (localValue) return localValue;
  } catch {
    // Continue to the browser cookie fallback.
  }
  const cookieValue = document.cookie.split("; ").find((cookie) => cookie.startsWith(`${GOOGLE_CLIENT_ID_STORAGE_KEY}=`))?.split("=").slice(1).join("=");
  return cookieValue ? decodeURIComponent(cookieValue) : import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
}

function persistGoogleClientId(value: string) {
  try {
    localStorage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, value);
  } catch {
    // The cookie below provides a durable fallback when local storage is restricted.
  }
  document.cookie = `${GOOGLE_CLIENT_ID_STORAGE_KEY}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

type SavedObsidianVault = { vaultName: string };

function readSavedObsidianVault(): SavedObsidianVault | null {
  try {
    const saved = localStorage.getItem(OBSIDIAN_VAULT_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as SavedObsidianVault;
    return parsed.vaultName ? parsed : null;
  } catch {
    return null;
  }
}

function persistObsidianVault(vaultName: string) {
  localStorage.setItem(OBSIDIAN_VAULT_STORAGE_KEY, JSON.stringify({ vaultName } satisfies SavedObsidianVault));
}

function readNotionReferences(): NotionReference[] {
  try {
    const saved = localStorage.getItem(NOTION_REFERENCES_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) as NotionReference[] : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readAttentionStatuses(): Record<string, AttentionStatus> {
  try {
    const saved = localStorage.getItem(ATTENTION_STATUS_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) as Record<string, AttentionStatus> : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readHiddenGoogleTasks() {
  try {
    const saved = localStorage.getItem(HIDDEN_GOOGLE_TASKS_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) as string[] : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set<string>();
  }
}

const verticals: Array<{ id: View; label: string; short: string; icon: typeof FolderOpen; description: string }> = [
  { id: "planning_repository", label: "Planning Repository", short: "Raw capture", icon: Inbox, description: "Unprocessed inputs waiting for a deliberate next step." },
  { id: "today", label: "Today", short: "Daily focus", icon: Target, description: "A small plan for clearing the runway and moving one outcome." },
  { id: "this_week", label: "This Week", short: "7-day commitments", icon: CalendarDays, description: "The commitments that matter before the next weekly review." },
  { id: "projects", label: "Projects", short: "Multi-step outcomes", icon: GitBranch, description: "Outcomes that need more than one action to finish." },
  { id: "app_ideas", label: "App Ideas / Someday", short: "Possibilities", icon: Lightbulb, description: "Interesting possibilities without a daily obligation." },
  { id: "waiting_for", label: "Waiting For", short: "Dependencies", icon: Clock3, description: "Follow-ups held by another person, document, or event." },
];

const areas = ["GrantGenie", "MSA / NPW", "Heritage Malawi / HM", "Personal / Admin", "Unassigned"];

function googleListContainer(listName: string): Container {
  const list = listName.toLowerCase();
  if (list.includes("today")) return "today";
  if (list.includes("week")) return "this_week";
  if (list.includes("project")) return "projects";
  if (list.includes("someday") || list.includes("idea")) return "app_ideas";
  if (list.includes("waiting")) return "waiting_for";
  return "planning_repository";
}

function localTaskFromGoogleRecord(record: GoogleTaskRecord, existing?: Task, googleTodaySubtask = false): Task {
  return {
    id: existing?.id ?? `google-${record.sourceId}`,
    sourceKey: record.sourceKey,
    title: record.title,
    container: googleTodaySubtask ? "today" : existing?.container ?? googleListContainer(record.listName),
    area: existing?.area ?? "Unassigned",
    project: existing?.project,
    priority: existing?.priority ?? "normal",
    due: record.due,
    source: "Google Tasks",
    completed: record.completed,
    completedAt: record.completed ? existing?.completedAt ?? "From Google Tasks" : undefined,
    notes: record.notes,
    successCriteria: existing?.successCriteria,
    googleParentId: record.parentSourceId,
    googleTodaySubtask,
    role: existing?.role,
  };
}

function googleTodaySubtaskIds(records: GoogleTaskRecord[]) {
  const byId = new Map(records.map((record) => [record.sourceId, record]));
  const todayIds = new Set(records.filter((record) => record.title.trim().toLowerCase() === "today").map((record) => record.sourceId));
  const descendants = new Set<string>();
  for (const record of records) {
    const visited = new Set<string>();
    let parentId = record.parentSourceId;
    while (parentId && !visited.has(parentId)) {
      if (todayIds.has(parentId)) {
        descendants.add(record.sourceId);
        break;
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentSourceId;
    }
  }
  return descendants;
}

const seedTasks: Task[] = [
  { id: "t1", title: "Review Q3 Marketing Strategy Draft and append notes from Monday sync", container: "planning_repository", area: "GrantGenie", project: "GrantGenie operating rhythm", priority: "normal", source: "Obsidian", completed: false, notes: "Capture the decision points and turn only clear commitments into tasks." },
  { id: "t2", title: "https://brutalistwebsites.com/ — good inspiration for the internal dashboard redesign", container: "app_ideas", area: "Personal / Admin", priority: "low", source: "Obsidian", completed: false, notes: "Reference link captured from a quick note." },
  { id: "t3", title: "Buy groceries for the week (check fridge first)", container: "today", area: "Personal / Admin", priority: "normal", estimate: 5, role: "quick_clear", source: "Google Tasks", completed: false },
  { id: "t4", title: "Call AWS support regarding unexpected billing spike on production cluster", container: "today", area: "MSA / NPW", project: "Reduce production spend", priority: "high", estimate: 5, role: "quick_clear", source: "Google Tasks", completed: false, due: "Today" },
  { id: "t5", title: "Write the first-pass grant search brief", container: "today", area: "GrantGenie", project: "GrantGenie operating rhythm", priority: "high", role: "main_outcome", source: "Google Tasks", completed: false, due: "Today", notes: "Finished means the brief is in Obsidian with search terms, exclusions, and a review date." },
  { id: "t6", title: "Open the repo and outline the first vertical slice", container: "today", area: "Personal / Admin", project: "Build Workboard OS", priority: "normal", role: "evening_build", source: "Manual", completed: false, estimate: 5, notes: "Start-up task before deep build." },
  { id: "t7", title: "Finalize Q3 Budget Proposal", container: "this_week", area: "MSA / NPW", project: "Q3 financial close", priority: "normal", due: "Wed", source: "Google Tasks", completed: false },
  { id: "t8", title: "Review Grant Application Draft", container: "this_week", area: "GrantGenie", project: "GrantGenie operating rhythm", priority: "normal", due: "Thu", source: "Google Tasks", completed: false },
  { id: "t9", title: "Prepare Board Meeting Presentation", container: "this_week", area: "Heritage Malawi / HM", priority: "high", due: "Fri", source: "Google Tasks", completed: false },
  { id: "t10", title: "Renew software licenses", container: "this_week", area: "Personal / Admin", priority: "normal", due: "Sat", source: "Google Tasks", completed: false },
  { id: "t11", title: "Sync with design team on mockups", container: "this_week", area: "GrantGenie", priority: "normal", completed: true, completedAt: "Mon", source: "Google Tasks" },
  { id: "t12", title: "Update weekly metrics dashboard", container: "this_week", area: "MSA / NPW", priority: "normal", completed: true, completedAt: "Tue", source: "Manual" },
  { id: "t13", title: "Request the signed MSA addendum from legal", container: "waiting_for", area: "MSA / NPW", project: "Q3 financial close", priority: "normal", source: "Google Tasks", completed: false, waitingOn: "Legal — signed addendum", due: "Aug 20" },
  { id: "t14", title: "Decide whether local-first sync belongs in the mobile app", container: "app_ideas", area: "Personal / Admin", priority: "low", source: "Obsidian", completed: false },
  { id: "t15", title: "Confirm board meeting date with HM team", container: "planning_repository", area: "Heritage Malawi / HM", priority: "normal", source: "Google Tasks", completed: false },
  { id: "t16", title: "Schedule dentist appointment", container: "planning_repository", area: "Personal / Admin", priority: "normal", completed: true, completedAt: "3 days ago", source: "Manual" },
  { id: "t17", title: "Reply to urgent Slack threads", container: "today", area: "Personal / Admin", priority: "normal", estimate: 5, role: "quick_clear", source: "Manual", completed: true, completedAt: "Today" },
  { id: "t18", title: "Check email triage", container: "today", area: "Personal / Admin", priority: "normal", estimate: 3, role: "quick_clear", source: "Manual", completed: true, completedAt: "Today" },
  { id: "t19", title: "Review calendar for tomorrow", container: "today", area: "Personal / Admin", priority: "normal", estimate: 1, role: "quick_clear", source: "Manual", completed: true, completedAt: "Today" },
];

const DEMO_TASK_IDS = new Set(seedTasks.map((task) => task.id));

function hydrateTasks(): Task[] {
  try {
    const saved = localStorage.getItem("workboard-tasks");
    if (!saved) return seedTasks;
    const parsed = JSON.parse(saved) as Task[];
    if (!Array.isArray(parsed)) return seedTasks;
    const existingIds = new Set(parsed.map((task) => task.id));
    return [...parsed, ...seedTasks.filter((task) => !existingIds.has(task.id))];
  } catch {
    return seedTasks;
  }
}

const projects: Project[] = [
  { id: "p1", name: "GrantGenie operating rhythm", area: "GrantGenie", outcome: "A repeatable weekly grant search and review loop with a clean brief as the handoff.", status: "on track", note: "[[GrantGenie / Operating Rhythm]]" },
  { id: "p2", name: "Q3 financial close", area: "MSA / NPW", outcome: "Close the quarter with the budget proposal and signed MSA addendum ready for review.", status: "at risk", note: "[[MSA / Q3 Close]]" },
  { id: "p3", name: "Build Workboard OS", area: "Personal / Admin", outcome: "A calm local-first operating view that makes the next action obvious.", status: "on track", note: "[[Projects / Workboard OS]]" },
  { id: "p4", name: "Heritage Malawi board prep", area: "Heritage Malawi / HM", outcome: "A focused board meeting presentation with the decisions and supporting metrics in place.", status: "paused", note: "[[HM / Board Prep]]" },
];

const iconFor = (id: View) => verticals.find((item) => item.id === id)?.icon ?? FolderOpen;

function App() {
  const [view, setView] = useState<View>("board");
  const [tasks, setTasks] = useState<Task[]>(hydrateTasks);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState("p1");
  const [query, setQuery] = useState("");
  const [areaFilter, setAreaFilter] = useState("All areas");
  const [capture, setCapture] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [obsidianPreview, setObsidianPreview] = useState<ObsidianVaultPreview | null>(null);
  const [savedObsidianVault, setSavedObsidianVault] = useState<SavedObsidianVault | null>(readSavedObsidianVault);
  const [googleTasksPreview, setGoogleTasksPreview] = useState<GoogleTasksPreview | null>(null);
  const [googleTasksConnecting, setGoogleTasksConnecting] = useState(false);
  const [googleTasksConnected, setGoogleTasksConnected] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(readGoogleClientId);
  const [gmailScan, setGmailScan] = useState<GmailScan | null>(null);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [taskEditor, setTaskEditor] = useState<{ mode: "create" | "edit"; role: Role; task: Task } | null>(null);
  const [notionStatus, setNotionStatus] = useState<NotionConnectionStatus>({ connected: false, configured: false });
  const [notionReferences, setNotionReferences] = useState<NotionReference[]>(readNotionReferences);
  const [notionResults, setNotionResults] = useState<NotionReference[]>([]);
  const [notionQuery, setNotionQuery] = useState("");
  const [notionSearching, setNotionSearching] = useState(false);
  const [attentionStatuses, setAttentionStatuses] = useState<Record<string, AttentionStatus>>(readAttentionStatuses);
  const [hiddenGoogleTaskKeys, setHiddenGoogleTaskKeys] = useState<Set<string>>(readHiddenGoogleTasks);
  const [selectedTodayTaskIds, setSelectedTodayTaskIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    void loadObsidianVaultHandle().then(async (handle) => {
      if (!handle || !active || (handle.queryPermission && await handle.queryPermission({ mode: "read" }) !== "granted")) return;
      const preview = await readObsidianDirectory(handle);
      if (active) {
        setObsidianPreview(preview);
        setSavedObsidianVault({ vaultName: preview.vaultName });
      }
    }).catch(() => {
      // The saved folder can still be chosen again from Settings if its permission expired.
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    async function restoreGoogleTasks() {
      try {
        const status = await getGoogleStatus();
        if (!active) return;
        setGoogleTasksConnected(status.connected);
        if (!status.connected) return;
        setGoogleTasksConnecting(true);
        const preview = await readConnectedGoogleTasks();
        if (active) {
          setGoogleTasksPreview(preview);
          mergeGoogleTasks(preview);
        }
      } catch {
        if (active) setGoogleTasksConnected(false);
      } finally {
        if (active) setGoogleTasksConnecting(false);
      }
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      window.history.replaceState({}, "", window.location.pathname);
      flash("Google Tasks connected · restoring read-only tasks");
    }
    void restoreGoogleTasks();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    void getNotionStatus().then(setNotionStatus).catch(() => undefined);
    if (new URLSearchParams(window.location.search).get("notion") === "connected") {
      window.history.replaceState({}, "", window.location.pathname);
      flash("Notion connected · choose read-only pages or databases");
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function restoreGmail() {
      try {
        const status = await getGmailStatus();
        if (!active) return;
        setGmailConnected(status.connected);
        if (status.connected) await runGmailScan(false);
      } catch {
        if (active) {
          setGmailConnected(false);
          setGmailError("Gmail connection status could not be restored.");
        }
      }
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") {
      setView("settings");
      window.history.replaceState({}, "", window.location.pathname);
      flash("Gmail connected · checking the last 7 days");
    }
    void restoreGmail();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    localStorage.setItem(NOTION_REFERENCES_STORAGE_KEY, JSON.stringify(notionReferences));
  }, [notionReferences]);

  useEffect(() => {
    localStorage.setItem("workboard-tasks", JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    localStorage.setItem(ATTENTION_STATUS_STORAGE_KEY, JSON.stringify(attentionStatuses));
  }, [attentionStatuses]);

  useEffect(() => {
    localStorage.setItem(HIDDEN_GOOGLE_TASKS_STORAGE_KEY, JSON.stringify([...hiddenGoogleTaskKeys]));
  }, [hiddenGoogleTaskKeys]);

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const matchesQuery = `${task.title} ${task.area} ${task.project ?? ""}`.toLowerCase().includes(query.toLowerCase());
    const matchesArea = areaFilter === "All areas" || task.area === areaFilter;
    return matchesQuery && matchesArea;
  }), [tasks, query, areaFilter]);

  const counts = useMemo(() => Object.fromEntries(verticals.map((vertical) => [vertical.id, tasks.filter((task) => task.container === vertical.id).length])), [tasks]);
  const demoTaskCount = useMemo(() => tasks.filter((task) => DEMO_TASK_IDS.has(task.id)).length, [tasks]);
  const gmailAttentionSignals = useMemo(() => (gmailScan?.candidates ?? []).map((candidate) => gmailCandidateToSignal(candidate)), [gmailScan]);
  const attentionSignals = useMemo(() => [...inspectWorkboard(tasks), ...gmailAttentionSignals], [tasks, gmailAttentionSignals]);
  const openAttentionCount = attentionSignals.filter((signal) => !["attended", "dismissed"].includes(attentionStatuses[signal.id] ?? "open")).length;
  const completedToday = tasks.filter((task) => task.container === "today" && task.completed).length;
  const quickClear = tasks.filter((task) => task.container === "today" && task.role === "quick_clear");
  const mainOutcome = tasks.find((task) => task.container === "today" && task.role === "main_outcome");
  const eveningTask = tasks.find((task) => task.container === "today" && task.role === "evening_build");
  const googleTaskOrder = useMemo(() => new Map((googleTasksPreview?.tasks ?? []).map((task, index) => [task.sourceKey, index])), [googleTasksPreview]);
  const todayTasks = useMemo(() => tasks.filter((task) => task.container === "today" && !task.role).sort((left, right) => {
    const leftOrder = left.sourceKey ? googleTaskOrder.get(left.sourceKey) : undefined;
    const rightOrder = right.sourceKey ? googleTaskOrder.get(right.sourceKey) : undefined;
    if (leftOrder === undefined && rightOrder === undefined) return 0;
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    return leftOrder - rightOrder;
  }), [googleTaskOrder, tasks]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2600);
  }

  function mergeGoogleTasks(preview: GoogleTasksPreview) {
    setTasks((current) => {
      const localTasks = preview.mode === "live" ? current.filter((task) => !DEMO_TASK_IDS.has(task.id)) : current;
      const existingBySource = new Map(localTasks.filter((task) => task.sourceKey).map((task) => [task.sourceKey, task]));
      const googleTodayIds = googleTodaySubtaskIds(preview.tasks);
      const imported = preview.tasks.filter((record) => !hiddenGoogleTaskKeys.has(record.sourceKey)).map((record) => localTaskFromGoogleRecord(record, existingBySource.get(record.sourceKey), googleTodayIds.has(record.sourceId)));
      const importedBySource = new Map(imported.map((task) => [task.sourceKey, task]));
      const merged = localTasks.map((task) => task.sourceKey && importedBySource.has(task.sourceKey) ? importedBySource.get(task.sourceKey)! : task);
      const existingKeys = new Set(localTasks.map((task) => task.sourceKey).filter(Boolean));
      return [...merged, ...imported.filter((task) => !existingKeys.has(task.sourceKey))];
    });
  }

  function openTodayTaskEditor(role: Role, task?: Task) {
    setTaskEditor({ mode: task ? "edit" : "create", role, task: task ? { ...task } : { id: `local-${Date.now()}`, title: "", container: "today", area: "Unassigned", priority: "normal", source: "Manual", completed: false, role } });
  }

  function saveTodayTask(draft: Task) {
    const title = draft.title.trim();
    if (!title) {
      flash("Add a task title first");
      return;
    }
    const mode = taskEditor?.mode;
    setTasks((current) => {
      const nextTask: Task = { ...draft, title, container: "today", source: draft.source === "Google Tasks" ? "Google Tasks" : "Manual", successCriteria: draft.role === "main_outcome" ? (draft.successCriteria ?? []).map((criterion) => criterion.trim()).filter(Boolean) : undefined };
      const withoutRole = nextTask.role && nextTask.role !== "quick_clear" ? current.map((task) => task.id === nextTask.id ? task : task.role === nextTask.role ? { ...task, role: null } : task) : current;
      return mode === "edit" ? withoutRole.map((task) => task.id === nextTask.id ? nextTask : task) : [nextTask, ...withoutRole];
    });
    setTaskEditor(null);
    flash(mode === "edit" ? "Today task updated locally" : "Today task added locally");
  }

  function removeTodayTask(task: Task) {
    if (!window.confirm(`Remove “${task.title}” from Today? This only changes WorkBoard locally.`)) return;
    if (task.source === "Google Tasks" && task.sourceKey) {
      setHiddenGoogleTaskKeys((current) => new Set(current).add(task.sourceKey!));
    }
    setTasks((current) => current.filter((item) => item.id !== task.id));
    setSelectedTodayTaskIds((current) => {
      const next = new Set(current);
      next.delete(task.id);
      return next;
    });
    flash(task.source === "Google Tasks" ? "Google subtask hidden locally · source unchanged" : "Today task removed locally");
  }

  function toggleTodayTaskSelection(id: string) {
    setSelectedTodayTaskIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllTodayTasks(selected: boolean) {
    setSelectedTodayTaskIds(selected ? new Set(todayTasks.map((task) => task.id)) : new Set());
  }

  function promoteTodayTasksToPhaseOne(ids: string[]) {
    if (!ids.length) return;
    const selected = new Set(ids);
    setTasks((current) => {
      const promoted = current.filter((task) => selected.has(task.id)).map((task) => ({ ...task, container: "today" as Container, role: "quick_clear" as const }));
      const remaining = current.filter((task) => !selected.has(task.id));
      const firstPhaseOneIndex = remaining.findIndex((task) => task.container === "today" && task.role === "quick_clear");
      if (firstPhaseOneIndex < 0) return [...promoted, ...remaining];
      return [...remaining.slice(0, firstPhaseOneIndex), ...promoted, ...remaining.slice(firstPhaseOneIndex)];
    });
    setSelectedTodayTaskIds(new Set());
    flash(`${ids.length} task${ids.length === 1 ? "" : "s"} moved to Phase 1 locally`);
  }

  function hideSelectedTodayTasks() {
    const selected = todayTasks.filter((task) => selectedTodayTaskIds.has(task.id));
    if (!selected.length) return;
    if (!window.confirm(`Hide ${selected.length} selected task${selected.length === 1 ? "" : "s"} from Today? This only changes WorkBoard locally.`)) return;
    const googleKeys = selected.flatMap((task) => task.source === "Google Tasks" && task.sourceKey ? [task.sourceKey] : []);
    if (googleKeys.length) setHiddenGoogleTaskKeys((current) => new Set([...current, ...googleKeys]));
    setTasks((current) => current.filter((task) => !selectedTodayTaskIds.has(task.id)));
    setSelectedTodayTaskIds(new Set());
    flash(`${selected.length} task${selected.length === 1 ? "" : "s"} hidden locally · source unchanged`);
  }

  function clearDemoTasks() {
    if (!window.confirm("Remove WorkBoard starter cards? Your Google Tasks will not be changed.")) return;
    setTasks((current) => current.filter((task) => !DEMO_TASK_IDS.has(task.id)));
    flash("Starter cards removed locally · Google Tasks unchanged");
  }

  function gmailCandidateToSignal(candidate: GmailCandidate): AttentionSignal {
    const snippet = candidate.snippet ? ` ${candidate.snippet.slice(0, 180)}` : "";
    return {
      id: `gmail-${candidate.id}`,
      category: "communication",
      severity: candidate.kind === "sent_follow_up" ? "high" : "medium",
      title: candidate.kind === "sent_follow_up" ? `Follow up: ${candidate.subject}` : `Incoming email: ${candidate.subject}`,
      detail: `${candidate.reason} ${candidate.suggestedAction}${snippet}`,
      taskIds: [],
      targetView: candidate.kind === "sent_follow_up" ? "today" : "planning_repository",
      actionLabel: "Open email",
      sourceUrl: candidate.sourceUrl,
    };
  }

  async function runGmailScan(showNotice = true) {
    setGmailConnecting(true);
    setGmailError(null);
    try {
      const result = await scanGmail();
      setGmailConnected(true);
      setGmailScan(result);
      if (showNotice) flash(`Communications Scout scanned ${result.candidates.length} candidate emails`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gmail scan failed";
      setGmailError(message);
      if (/not connected|expired|reconnect/i.test(message)) setGmailConnected(false);
      flash(message);
    } finally {
      setGmailConnecting(false);
    }
  }

  function connectGmail() {
    if (gmailConnecting) return;
    setGmailConnecting(true);
    startGmailOAuth();
  }

  function setAttentionStatus(signal: AttentionSignal, status: AttentionStatus) {
    setAttentionStatuses((current) => ({ ...current, [signal.id]: status }));
    flash(status === "attended" ? "Marked attended locally" : status === "deferred" ? "Deferred for later review" : "Dismissed locally");
  }

  async function refreshGoogleTasks(showNotice = true) {
    setGoogleTasksConnecting(true);
    try {
      const preview = await readConnectedGoogleTasks();
      setGoogleTasksConnected(true);
      setGoogleTasksPreview(preview);
      mergeGoogleTasks(preview);
      if (showNotice) flash(`Google Tasks refreshed read-only · ${preview.tasks.length} records`);
    } catch (error) {
      setGoogleTasksConnected(false);
      flash(error instanceof Error ? error.message : "Google Tasks could not be restored");
    } finally {
      setGoogleTasksConnecting(false);
    }
  }

  function toggleTask(id: string) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, completed: !task.completed, completedAt: !task.completed ? "Just now" : undefined } : task));
    flash("Saved locally · source task unchanged");
  }

  function moveTask(id: string, container: Container) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, container, role: container === "today" ? task.role : null } : task));
    flash(`Moved to ${verticals.find((item) => item.id === container)?.label ?? container}`);
  }

  function reorderTask(id: string, targetId: string | null, targetContainer: Container) {
    setTasks((current) => {
      const source = current.find((task) => task.id === id);
      if (!source || targetId === id) return current;
      const moved = { ...source, container: targetContainer, role: targetContainer === "today" ? source.role : null };
      const withoutSource = current.filter((task) => task.id !== id);
      const reordered: Task[] = [];
      let inserted = false;
      for (const task of withoutSource) {
        if (!inserted && task.container === targetContainer && task.id === targetId) {
          reordered.push(moved);
          inserted = true;
        }
        reordered.push(task);
      }
      if (!inserted) reordered.push(moved);
      return reordered;
    });
    flash(targetId ? "Card reordered" : `Moved to ${verticals.find((item) => item.id === targetContainer)?.label ?? targetContainer}`);
  }

  function setRole(id: string, role: Role) {
    setTasks((current) => current.map((task) => {
      if (task.id === id) return { ...task, role, container: "today" };
      if (role && role !== "quick_clear" && task.role === role) return { ...task, role: null };
      return task;
    }));
    flash(role ? "Daily role updated" : "Daily role cleared");
  }

  function addCapture() {
    const title = capture.trim();
    if (!title) return;
    setTasks((current) => [{ id: `local-${Date.now()}`, title, container: "planning_repository", area: "Unassigned", priority: "normal", source: "Manual", completed: false }, ...current]);
    setCapture("");
    flash("Captured to Planning Repository");
  }

  async function connectObsidian(files: FileList | null) {
    if (!files?.length) return;
    try {
      const preview = await readObsidianVault([...files]);
      setObsidianPreview(preview);
      const savedVault = { vaultName: preview.vaultName } satisfies SavedObsidianVault;
      persistObsidianVault(savedVault.vaultName);
      setSavedObsidianVault(savedVault);
      flash(`Obsidian connected · ${preview.noteCount} Markdown notes read-only`);
    } catch {
      flash("Obsidian preview failed · vault unchanged");
    }
  }

  async function connectObsidianDirectory() {
    if (!window.showDirectoryPicker) return;
    try {
      const handle = await window.showDirectoryPicker();
      await saveObsidianVaultHandle(handle);
      const preview = await readObsidianDirectory(handle);
      setObsidianPreview(preview);
      const savedVault = { vaultName: preview.vaultName } satisfies SavedObsidianVault;
      persistObsidianVault(savedVault.vaultName);
      setSavedObsidianVault(savedVault);
      flash(`Obsidian connected · ${preview.noteCount} Markdown notes read-only`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      flash("Obsidian preview failed · vault unchanged");
    }
  }

  async function previewGoogleTasks() {
    const preview = await syntheticGoogleTasksAdapter.preview();
    setGoogleTasksPreview(preview);
    flash(`Google Tasks dry-run ready · ${preview.tasks.length} records · no provider writes`);
  }

  function connectGoogleTasks() {
    if (googleTasksConnecting) return;
    setGoogleTasksConnecting(true);
    startGoogleOAuth();
  }

  function saveGoogleClientId() {
    const clientId = googleClientId.trim();
    if (!clientId) {
      flash("Paste a Google client ID first");
      return;
    }
    persistGoogleClientId(clientId);
    setGoogleClientId(clientId);
    flash("Google client ID saved locally");
  }

  function connectNotion() {
    if (!notionStatus.configured) {
      flash("Notion OAuth needs local server setup first");
      return;
    }
    startNotionOAuth();
  }

  async function findNotionReferences() {
    setNotionSearching(true);
    try {
      setNotionResults(await searchNotion(notionQuery.trim()));
    } catch (error) {
      flash(error instanceof Error ? error.message : "Notion search failed");
    } finally {
      setNotionSearching(false);
    }
  }

  function addNotionReference(reference: NotionReference) {
    setNotionReferences((current) => current.some((item) => item.id === reference.id) ? current : [...current, reference]);
    flash("Notion reference scoped locally");
  }

  function removeNotionReference(id: string) {
    setNotionReferences((current) => current.filter((item) => item.id !== id));
    flash("Notion reference removed locally");
  }

  function navigate(nextView: View) {
    setView(nextView);
    setMobileNav(false);
    setQuery("");
    setExpandedTask(null);
  }

  return (
    <div className={`app-shell ${view === "board" ? "board-mode" : view === "today" ? "today-mode" : ""}`}>
      <button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
      <Sidebar view={view} navigate={navigate} mobileNav={mobileNav} close={() => setMobileNav(false)} counts={counts} attentionCount={openAttentionCount} />
      <main className="main-canvas">
        <div className="mobile-header"><span className="brand-mark">W</span><span>Work OS</span><span className="mobile-header-spacer" /><button className="icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><PanelLeft size={18} /></button></div>
        {view === "board" && <BoardOverview tasks={tasks} counts={counts} liveGoogleTasks={googleTasksConnected} navigate={navigate} onToggle={toggleTask} onReorder={reorderTask} />}
        {view === "today" && <TodayView tasks={tasks} todayTasks={todayTasks} quickClear={quickClear} mainOutcome={mainOutcome} eveningTask={eveningTask} completedToday={completedToday} selectedTaskIds={selectedTodayTaskIds} onToggle={toggleTask} onMove={moveTask} onRole={setRole} onExpand={setExpandedTask} expandedTask={expandedTask} onAddTask={openTodayTaskEditor} onEditTask={(task) => openTodayTaskEditor(task.role ?? null, task)} onRemoveTask={removeTodayTask} onToggleSelection={toggleTodayTaskSelection} onSelectAll={selectAllTodayTasks} onPromoteToPhaseOne={promoteTodayTasksToPhaseOne} onHideSelected={hideSelectedTodayTasks} />}
        {view === "planning_repository" && <VerticalView view="planning_repository" tasks={filteredTasks.filter((task) => task.container === "planning_repository")} query={query} setQuery={setQuery} capture={capture} setCapture={setCapture} addCapture={addCapture} areaFilter={areaFilter} setAreaFilter={setAreaFilter} onToggle={toggleTask} onMove={moveTask} onRole={setRole} onReorder={reorderTask} onExpand={setExpandedTask} expandedTask={expandedTask} />}
        {view === "this_week" && <VerticalView view="this_week" tasks={filteredTasks.filter((task) => task.container === "this_week")} query={query} setQuery={setQuery} capture={capture} setCapture={setCapture} addCapture={addCapture} areaFilter={areaFilter} setAreaFilter={setAreaFilter} onToggle={toggleTask} onMove={moveTask} onRole={setRole} onReorder={reorderTask} onExpand={setExpandedTask} expandedTask={expandedTask} />}
        {view === "app_ideas" && <VerticalView view="app_ideas" tasks={filteredTasks.filter((task) => task.container === "app_ideas")} query={query} setQuery={setQuery} capture={capture} setCapture={setCapture} addCapture={addCapture} areaFilter={areaFilter} setAreaFilter={setAreaFilter} onToggle={toggleTask} onMove={moveTask} onRole={setRole} onReorder={reorderTask} onExpand={setExpandedTask} expandedTask={expandedTask} />}
        {view === "waiting_for" && <VerticalView view="waiting_for" tasks={filteredTasks.filter((task) => task.container === "waiting_for")} query={query} setQuery={setQuery} capture={capture} setCapture={setCapture} addCapture={addCapture} areaFilter={areaFilter} setAreaFilter={setAreaFilter} onToggle={toggleTask} onMove={moveTask} onRole={setRole} onReorder={reorderTask} onExpand={setExpandedTask} expandedTask={expandedTask} />}
        {view === "projects" && <ProjectsView tasks={tasks} selectedProject={selectedProject} setSelectedProject={setSelectedProject} onToggle={toggleTask} />}
        {view === "attention" && <AttentionQueueView signals={attentionSignals} statuses={attentionStatuses} navigate={navigate} onStatus={setAttentionStatus} />}
        {view === "review" && <ReviewView tasks={tasks} navigate={navigate} onMove={moveTask} />}
        {view === "settings" && <SettingsView flash={flash} obsidianPreview={obsidianPreview} savedObsidianVault={savedObsidianVault} onObsidianFiles={connectObsidian} onObsidianDirectoryPick={connectObsidianDirectory} onObsidianDisconnect={async () => { setObsidianPreview(null); localStorage.removeItem(OBSIDIAN_VAULT_STORAGE_KEY); setSavedObsidianVault(null); await removeObsidianVaultHandle().catch(() => undefined); flash("Obsidian disconnected · vault unchanged"); }} googleTasksPreview={googleTasksPreview} googleTasksConnected={googleTasksConnected} googleTasksConnecting={googleTasksConnecting} demoTaskCount={demoTaskCount} onClearDemoTasks={clearDemoTasks} onGoogleTasksPreview={previewGoogleTasks} onGoogleTasksConnect={connectGoogleTasks} onGoogleTasksRefresh={() => refreshGoogleTasks()} gmailScan={gmailScan} gmailError={gmailError} gmailConnected={gmailConnected} gmailConnecting={gmailConnecting} onGmailConnect={connectGmail} onGmailScan={() => runGmailScan()} onOpenAttention={() => navigate("attention")} googleClientId={googleClientId} onGoogleClientIdChange={setGoogleClientId} onSaveGoogleClientId={saveGoogleClientId} notionStatus={notionStatus} notionReferences={notionReferences} notionResults={notionResults} notionQuery={notionQuery} notionSearching={notionSearching} onNotionConnect={connectNotion} onNotionQueryChange={setNotionQuery} onNotionSearch={findNotionReferences} onNotionAddReference={addNotionReference} onNotionRemoveReference={removeNotionReference} />}
      </main>
      {taskEditor && <TodayTaskEditor mode={taskEditor.mode} role={taskEditor.role} task={taskEditor.task} onCancel={() => setTaskEditor(null)} onSave={saveTodayTask} />}
      {notice && <div className="toast"><Check size={15} /> {notice}</div>}
    </div>
  );
}

function Sidebar({ view, navigate, mobileNav, close, counts, attentionCount }: { view: View; navigate: (view: View) => void; mobileNav: boolean; close: () => void; counts: Record<string, number>; attentionCount: number }) {
  return <>
    {mobileNav && <button className="mobile-scrim" onClick={close} aria-label="Close navigation" />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <div>
        <div className="sidebar-brand"><div className="brand-mark">W</div><div><div className="brand-title">Work OS</div><div className="eyebrow">PRODUCTIVITY SYSTEM</div></div><button className="sidebar-close icon-button" onClick={close}><X size={18} /></button></div>
        <button className={`board-parent ${view === "board" ? "active" : ""}`} onClick={() => navigate("board")}><KanbanSquare size={18} /><span>Work Board</span><ChevronDown size={15} className="board-chevron" /></button>
        <nav className="sidebar-nav" aria-label="Work board views">
          {verticals.map((item) => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => navigate(item.id)}><Icon size={17} /><span>{item.label}</span><span className="nav-count">{counts[item.id] ?? 0}</span></button>; })}
        </nav>
      </div>
      <div className="sidebar-footer">
        <div className="eyebrow footer-label">AREAS</div>
        <button className="context-item"><Sparkles size={16} /> GrantGenie</button>
        <button className="context-item"><BriefcaseBusiness size={16} /> MSA / NPW</button>
        <button className="context-item"><BookOpen size={16} /> Heritage Malawi / HM</button>
        <button className="context-item"><UserRound size={16} /> Personal / Admin</button>
        <div className="footer-divider" />
        <button className={`context-item ${view === "attention" ? "context-active" : ""}`} onClick={() => navigate("attention")}><Sparkles size={16} /> Attention Queue {attentionCount > 0 && <span className="review-dot">{attentionCount}</span>}</button>
        <button className={`context-item ${view === "review" ? "context-active" : ""}`} onClick={() => navigate("review")}><Bell size={16} /> Weekly Review <span className="review-dot">7</span></button>
        <button className={`context-item ${view === "settings" ? "context-active" : ""}`} onClick={() => navigate("settings")}><SettingsIcon size={16} /> Settings</button>
      </div>
    </aside>
  </>;
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow ?? "WORK OS / CONTROL"}</div><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="header-actions">{actions}</div>}</header>;
}

function BoardOverview({ tasks, counts, liveGoogleTasks, navigate, onToggle, onReorder }: { tasks: Task[]; counts: Record<string, number>; liveGoogleTasks: boolean; navigate: (view: View) => void; onToggle: (id: string) => void; onReorder: (id: string, targetId: string | null, targetContainer: Container) => void }) {
  return <div className="content-wrap board-overview-page"><PageHeader eyebrow="WORK BOARD / OVERVIEW" title="Work Board Overview" description="Columns" actions={<button className="button outline small" onClick={() => navigate("settings")}><SettingsIcon size={13} /> Edit</button>} />
    <section className="board-intro"><div><span className="live-indicator" /> {liveGoogleTasks ? "GOOGLE TASKS LIVE · READ-ONLY" : "LOCAL DEMO DATA · READY TO PLAN"}</div><div className="board-date">Thursday · 17 August 2026</div></section>
    <div className="board-grid">{verticals.map((vertical) => { const Icon = vertical.icon; const preview = tasks.filter((task) => task.container === vertical.id).slice(0, 4); return <section className="board-column" key={vertical.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/workboard-task"); if (id) onReorder(id, null, vertical.id as Container); }}>
      <button className="column-heading" onClick={() => navigate(vertical.id)}><span className="column-icon"><Icon size={17} /></span><span><strong>{vertical.label}</strong><small>{vertical.short}</small></span><span className="column-count">{counts[vertical.id] ?? 0}</span></button>
      <div className="preview-stack">{preview.length ? preview.map((task) => <button draggable={true} className={`preview-card ${task.completed ? "is-complete" : ""}`} key={task.id} title="Drag to reorder or move" onDragStart={(event) => { event.dataTransfer.setData("text/workboard-task", task.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer.getData("text/workboard-task"); if (id) onReorder(id, task.id, vertical.id as Container); }} onClick={() => navigate(vertical.id)}><span className={`mini-check ${task.completed ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onToggle(task.id); }}>{task.completed && <Check size={12} />}</span><span className="preview-title">{task.title}</span>{task.priority === "high" && <span className="priority-dot" />}</button>) : <div className="empty-preview">Drop a card here.</div>}</div>
      <button className="view-all" onClick={() => navigate(vertical.id)}>View all <ArrowRight size={14} /></button>
    </section>; })}</div>
    <section className="board-footer-note"><CircleHelp size={16} /><span>Drag a card to reorder it or drop it onto another vertical. Use <strong>Move to</strong> for precise keyboard movement.</span></section>
  </div>;
}

function TaskDestinationSelect({ task, onMove, onRole, ariaLabel }: { task: Task; onMove: (id: string, container: Container) => void; onRole: (id: string, role: Role) => void; ariaLabel: string }) {
  const moveValue = task.container === "today" && task.role ? `today:${task.role}` : task.container;
  const handleMove = (value: string) => {
    if (value.startsWith("today:")) {
      onRole(task.id, value.replace("today:", "") as Exclude<Role, null>);
      return;
    }
    if (value === "today") {
      onRole(task.id, null);
      return;
    }
    onMove(task.id, value as Container);
  };
  return <select value={moveValue} onChange={(event) => handleMove(event.target.value)} aria-label={ariaLabel}><option value="planning_repository">Planning Repository</option><optgroup label="Today"><option value="today">Today · unassigned</option><option value="today:quick_clear">Phase 1 · Clear the runway</option><option value="today:main_outcome">Today’s one thing</option><option value="today:evening_build">Evening build</option></optgroup><option value="this_week">This Week</option><option value="projects">Projects</option><option value="app_ideas">App Ideas / Someday</option><option value="waiting_for">Waiting For</option></select>;
}

function TodayView({ tasks, todayTasks, quickClear, mainOutcome, eveningTask, completedToday, selectedTaskIds, onToggle, onMove, onRole, onExpand, expandedTask, onAddTask, onEditTask, onRemoveTask, onToggleSelection, onSelectAll, onPromoteToPhaseOne, onHideSelected }: { tasks: Task[]; todayTasks: Task[]; quickClear: Task[]; mainOutcome?: Task; eveningTask?: Task; completedToday: number; selectedTaskIds: Set<string>; onToggle: (id: string) => void; onMove: (id: string, container: Container) => void; onRole: (id: string, role: Role) => void; onExpand: (id: string | null) => void; expandedTask: string | null; onAddTask: (role: Role, task?: Task) => void; onEditTask: (task: Task) => void; onRemoveTask: (task: Task) => void; onToggleSelection: (id: string) => void; onSelectAll: (selected: boolean) => void; onPromoteToPhaseOne: (ids: string[]) => void; onHideSelected: () => void }) {
  const [todayTaskQuery, setTodayTaskQuery] = useState("");
  const dueToday = tasks.filter((task) => task.container === "this_week" && !task.completed).slice(0, 2);
  const overdue = tasks.filter((task) => task.priority === "high" && task.container !== "today" && !task.completed).slice(0, 1);
  const recommended = tasks.filter((task) => task.container === "app_ideas" && !task.completed).slice(0, 1);
  const completedRunway = quickClear.filter((task) => task.completed).length;
  const visibleTodayTasks = useMemo(() => {
    const normalizedQuery = todayTaskQuery.trim().toLowerCase();
    if (!normalizedQuery) return todayTasks;
    return todayTasks.filter((task) => `${task.title} ${task.source} ${task.area} ${task.project ?? ""}`.toLowerCase().includes(normalizedQuery));
  }, [todayTaskQuery, todayTasks]);
  const selectedTodayTasks = todayTasks.filter((task) => selectedTaskIds.has(task.id));
  const allTodayTasksSelected = todayTasks.length > 0 && selectedTodayTasks.length === todayTasks.length;
  const startClearing = () => { const next = quickClear.find((task) => !task.completed); if (next) onToggle(next.id); };
  const allowPhaseOneDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; };
  const dropOnPhaseOne = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData("text/workboard-task"); if (!draggedId) return; onPromoteToPhaseOne(selectedTaskIds.has(draggedId) ? [...selectedTaskIds] : [draggedId]); };
  const dropOnTodayTasks = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData("text/workboard-task"); if (!draggedId) return; onRole(draggedId, null); };
  return <div className="content-wrap today-page today-reference-layout"><PageHeader eyebrow="WORK BOARD / TODAY" title="Today" description="Start light, complete one important thing, then build in the evening." actions={<div className="today-date-status"><span className="today-date-chip">17 AUG</span><span className="sync-state"><span className="sync-dot" /> Synced</span></div>} />
    <section className="today-reference-section runway-section"><div className="today-reference-heading"><div><h2>Phase 1 — Clear the runway</h2><span>{completedRunway} of {quickClear.length} cleared</span></div><button className="text-button today-add-button" onClick={() => onAddTask("quick_clear")}>+ Add task</button></div><div className="runway-panel phase-one-drop-zone" onDragEnter={allowPhaseOneDrop} onDragOver={allowPhaseOneDrop} onDropCapture={dropOnPhaseOne}>{quickClear.length ? quickClear.map((task) => <div draggable className={`runway-row ${task.completed ? "done" : ""}`} key={task.id} onDragStart={(event) => { event.dataTransfer.setData("text/workboard-task", task.id); event.dataTransfer.effectAllowed = "move"; }}><button className={`reference-check ${task.completed ? "checked" : ""}`} onClick={() => onToggle(task.id)} aria-label={`Complete ${task.title}`}>{task.completed && <Check size={10} />}</button><button className="runway-title" onClick={() => onExpand(expandedTask === task.id ? null : task.id)}>{task.title}</button><span className="minute-badge">{task.estimate ?? 5} MIN</span><label className="today-move-control">Move to <TaskDestinationSelect task={task} onMove={onMove} onRole={onRole} ariaLabel={`Move ${task.title}`} /></label><div className="today-task-actions"><button className="text-button" onClick={() => onEditTask(task)}>Edit</button><button className="text-button danger-text" onClick={() => onRemoveTask(task)}>Remove</button></div></div>) : <div className="today-empty-panel">No runway tasks yet. Add the quick wins you want to clear first.</div>}</div><div className="reference-action-row"><button className="button dark reference-button" onClick={startClearing} disabled={!quickClear.some((task) => !task.completed)}><Timer size={13} /> Start clearing</button></div></section>
    <section className="today-reference-section"><div className="today-section-title-row"><h2 className="reference-section-title">Today’s main outcome</h2><button className="text-button today-add-button" onClick={() => onAddTask("main_outcome")}>{mainOutcome ? "Edit main task" : "+ Add main task"}</button></div><div className="main-outcome-card"><div className="outcome-rail" /><div className="main-outcome-content"><div className="outcome-tags"><span>Project: {mainOutcome?.project ?? "Unassigned"}</span><span>Area: {mainOutcome?.area ?? "Unassigned"}</span></div><h3>{mainOutcome?.title ?? "No main task assigned"}</h3><div className="expected-outcome"><span>Expected outcome</span><p>{mainOutcome?.notes ?? "Add the one result that would make today successful."}</p></div>{mainOutcome?.successCriteria?.length ? <div className="success-criteria"><span>Success criteria</span><ul>{mainOutcome.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div> : null}<div className="today-action-cluster">{mainOutcome ? <><button className="button dark reference-button" onClick={() => onToggle(mainOutcome.id)}>{mainOutcome.completed ? <Check size={13} /> : <ArrowRight size={13} />}{mainOutcome.completed ? "Completed" : "Start primary task"}</button><label className="today-move-control">Move to <TaskDestinationSelect task={mainOutcome} onMove={onMove} onRole={onRole} ariaLabel={`Move ${mainOutcome.title}`} /></label><button className="button outline reference-button" onClick={() => onEditTask(mainOutcome)}>Edit</button><button className="text-button danger-text" onClick={() => onRemoveTask(mainOutcome)}>Remove</button></> : <button className="button dark reference-button" onClick={() => onAddTask("main_outcome")}><Plus size={13} /> Add main task</button>}</div></div></div></section>
    <section className="today-reference-section"><div className="today-reference-heading"><div><h2>Today tasks</h2><span>{todayTaskQuery ? `${visibleTodayTasks.length} of ${todayTasks.length} matching` : `${todayTasks.length} local view${todayTasks.some((task) => task.source === "Google Tasks") ? " · Google order" : ""}`}</span></div><button className="text-button today-add-button" onClick={() => onAddTask(null)}>+ Add local task</button></div><label className="today-task-search"><Search size={15} /><span className="today-task-search-label">Search</span><input value={todayTaskQuery} onChange={(event) => setTodayTaskQuery(event.target.value)} placeholder="Search Today tasks…" aria-label="Search Today tasks" />{todayTaskQuery && <button type="button" className="text-button" onClick={() => setTodayTaskQuery("")}>Clear</button>}</label><div className="today-bulk-toolbar"><label className="bulk-select-control"><input type="checkbox" checked={allTodayTasksSelected} disabled={!todayTasks.length} onChange={(event) => onSelectAll(event.target.checked)} /><span>Select all</span></label>{selectedTodayTasks.length > 0 && <><span className="bulk-selection-count">{selectedTodayTasks.length} selected</span><div className="bulk-task-actions"><button className="button outline small" onClick={() => onPromoteToPhaseOne([...selectedTaskIds])}>Move to Phase 1</button><button className="button outline small danger-button" onClick={onHideSelected}>Hide selected</button></div></>}</div><div className="runway-panel today-tasks-drop-zone" onDragEnter={allowPhaseOneDrop} onDragOver={allowPhaseOneDrop} onDropCapture={dropOnTodayTasks}>{visibleTodayTasks.length ? visibleTodayTasks.map((task) => <div draggable className={`runway-row ${task.completed ? "done" : ""} ${task.googleTodaySubtask ? "google-subtask-row" : ""}`} key={task.id} onDragStart={(event) => { event.dataTransfer.setData("text/workboard-task", task.id); event.dataTransfer.effectAllowed = "move"; }}><label className="task-selection-control"><input type="checkbox" checked={selectedTaskIds.has(task.id)} onChange={() => onToggleSelection(task.id)} aria-label={`Select ${task.title}`} /></label><button className={`reference-check ${task.completed ? "checked" : ""}`} onClick={() => onToggle(task.id)} aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`}>{task.completed && <Check size={10} />}</button><button className="runway-title" onClick={() => onExpand(expandedTask === task.id ? null : task.id)}>{task.title}</button>{task.googleTodaySubtask && <span className="task-source-label">GOOGLE</span>}<span className="minute-badge">{task.estimate ?? 5} MIN</span><label className="today-move-control">Move to <TaskDestinationSelect task={task} onMove={onMove} onRole={onRole} ariaLabel={`Move ${task.title}`} /></label><div className="today-task-actions"><button className="text-button" onClick={() => onEditTask(task)}>Edit</button><button className="text-button danger-text" onClick={() => onRemoveTask(task)}>{task.source === "Google Tasks" ? "Hide" : "Remove"}</button></div></div>) : <div className="today-empty-panel">{todayTaskQuery ? "No Today tasks match that search." : "No extra Today tasks yet. Google subtasks under a task named “Today” will appear here automatically."}</div>}</div></section>
    <section className="today-reference-section"><div className="today-section-title-row"><h2 className="reference-section-title">Evening build</h2><button className="text-button today-add-button" onClick={() => onAddTask("evening_build")}>{eveningTask ? "Edit build" : "+ Add build task"}</button></div><div className="evening-build-card"><div className="evening-build-main">{eveningTask ? <><h3>{eveningTask.project ?? eveningTask.title}</h3><span className="build-outcome-tag">{eveningTask.notes ?? "Evening build task"}</span><div className="build-task"><button className={`reference-check ${eveningTask.completed ? "checked" : ""}`} onClick={() => onToggle(eveningTask.id)} aria-label={`Complete ${eveningTask.title}`}>{eveningTask.completed && <Check size={10} />}</button><span>{eveningTask.title}</span><span className="mini-minute">{eveningTask.estimate ?? 5}m</span></div></> : <div className="today-empty-panel"><strong>No evening build assigned</strong><span>Add one focused task for the evening.</span></div>}</div>{eveningTask && <div className="today-action-cluster"><button className="button outline reference-button" onClick={() => onToggle(eveningTask.id)}>{eveningTask.completed ? "Completed" : "Start build"}</button><label className="today-move-control">Move to <TaskDestinationSelect task={eveningTask} onMove={onMove} onRole={onRole} ariaLabel={`Move ${eveningTask.title}`} /></label><button className="text-button" onClick={() => onEditTask(eveningTask)}>Edit</button><button className="text-button danger-text" onClick={() => onRemoveTask(eveningTask)}>Remove</button></div>}</div></section>
    <section className="today-secondary-reference"><TodayInfoCard title="Due today" count={dueToday.length} tasks={dueToday} onToggle={onToggle} /><TodayInfoCard title="Overdue" count={overdue.length} tasks={overdue} onToggle={onToggle} warning /><TodayInfoCard title="Recommended next" count={recommended.length} tasks={recommended} onToggle={onToggle} /></section>
  </div>;
}

function TodayTaskEditor({ mode, role, task, onCancel, onSave }: { mode: "create" | "edit"; role: Role; task: Task; onCancel: () => void; onSave: (task: Task) => void }) {
  const [draft, setDraft] = useState<TaskEditorDraft>({ title: task.title, area: task.area, project: task.project, priority: task.priority, due: task.due, estimate: task.estimate, notes: task.notes, successCriteria: task.successCriteria ?? [], role });
  const update = <K extends keyof TaskEditorDraft>(key: K, value: TaskEditorDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const roleLabel = role === "quick_clear" ? "Phase 1 · Clear the runway" : role === "main_outcome" ? "Today’s main task" : role === "evening_build" ? "Evening build" : "Today task";
  const outcomeField = role === "main_outcome";
  const successCriteria = draft.successCriteria ?? [];
  const addSuccessCriterion = () => update("successCriteria", [...successCriteria, ""]);
  const updateSuccessCriterion = (index: number, value: string) => update("successCriteria", successCriteria.map((criterion, criterionIndex) => criterionIndex === index ? value : criterion));
  const removeSuccessCriterion = (index: number) => update("successCriteria", successCriteria.filter((_, criterionIndex) => criterionIndex !== index));
  return <div className="task-editor-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}><form className="task-editor" onSubmit={(event) => { event.preventDefault(); onSave({ ...task, ...draft, role }); }}><div className="task-editor-header"><div><span className="eyebrow">TODAY / {mode === "edit" ? "EDIT TASK" : "NEW TASK"}</span><h2>{roleLabel}</h2></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Close task editor"><X size={18} /></button></div><label>Task title<input autoFocus value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder="What needs to happen?" /></label><label>{outcomeField ? "Expected outcome" : "Notes or expected outcome"}<textarea value={draft.notes ?? ""} onChange={(event) => update("notes", event.target.value)} placeholder={outcomeField ? "Add the one result that would make today successful." : "What does done look like?"} rows={3} /></label>{outcomeField && <div className="success-criteria-editor"><div className="field-label-row"><span>Success criteria</span><button type="button" className="text-button" onClick={addSuccessCriterion}>+ Add criterion</button></div>{successCriteria.map((criterion, index) => <div className="success-criterion-row" key={`criterion-${index}`}><input value={criterion} onChange={(event) => updateSuccessCriterion(index, event.target.value)} placeholder={`Criterion ${index + 1}`} /><button type="button" className="icon-button remove-criterion" onClick={() => removeSuccessCriterion(index)} aria-label={`Remove criterion ${index + 1}`}><X size={15} /></button></div>)}{successCriteria.length === 0 && <p className="field-hint">Optional. Add the concrete outputs that show the primary outcome is complete.</p>}</div>}<div className="task-editor-grid"><label>Area<select value={draft.area} onChange={(event) => update("area", event.target.value)}>{areas.map((area) => <option key={area}>{area}</option>)}</select></label><label>Project<input value={draft.project ?? ""} onChange={(event) => update("project", event.target.value)} placeholder="Optional" /></label><label>Priority<select value={draft.priority} onChange={(event) => update("priority", event.target.value as Task["priority"])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label><label>Due date<input type="date" value={draft.due ?? ""} onChange={(event) => update("due", event.target.value || undefined)} /></label><label>Minutes<input type="number" min="1" value={draft.estimate ?? 5} onChange={(event) => update("estimate", Number(event.target.value) || 5)} /></label></div><p className="task-editor-note">Changes here stay in WorkBoard. Provider tasks remain read-only.</p><div className="task-editor-actions"><button type="button" className="button outline" onClick={onCancel}>Cancel</button><button type="submit" className="button dark">{mode === "edit" ? "Save changes" : "Add to Today"}</button></div></form></div>;
}

function TodayInfoCard({ title, count, tasks, onToggle, warning = false }: { title: string; count: number; tasks: Task[]; onToggle: (id: string) => void; warning?: boolean }) {
  return <section className={`today-info-card ${warning ? "warning" : ""}`}><div className="today-info-heading"><h3>{title}</h3>{count > 0 && <span>{count}</span>}</div>{tasks.length ? tasks.map((task) => <div className="today-info-task" key={task.id}><button className={`reference-check ${task.completed ? "checked" : ""}`} onClick={() => onToggle(task.id)}>{task.completed && <Check size={10} />}</button><div><strong>{task.title}</strong>{warning && <small>{task.due ?? "Yesterday"}</small>}</div></div>) : <p className="today-empty-copy">Nothing queued.</p>}</section>;
}

function VerticalView({ view, tasks, query, setQuery, capture, setCapture, addCapture, areaFilter, setAreaFilter, onToggle, onMove, onRole, onReorder, onExpand, expandedTask }: { view: Exclude<Container, "projects">; tasks: Task[]; query: string; setQuery: (value: string) => void; capture: string; setCapture: (value: string) => void; addCapture: () => void; areaFilter: string; setAreaFilter: (value: string) => void; onToggle: (id: string) => void; onMove: (id: string, container: Container) => void; onRole: (id: string, role: Role) => void; onReorder: (id: string, targetId: string | null, targetContainer: Container) => void; onExpand: (id: string | null) => void; expandedTask: string | null }) {
  const item = verticals.find((vertical) => vertical.id === view)!;
  const isPlanning = view === "planning_repository";
  return <div className="content-wrap"><PageHeader eyebrow={`WORK BOARD / ${item.label.toUpperCase()}`} title={item.label} description={item.description} actions={<button className="button primary" onClick={isPlanning ? addCapture : undefined}><Plus size={16} /> New task</button>} />
    {isPlanning && <div className="capture-bar"><Plus size={18} /><input value={capture} onChange={(event) => setCapture(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addCapture()} placeholder="Log a thought, task, or URL…" /><button className="button dark" onClick={addCapture}>Capture</button></div>}
    <div className="list-toolbar"><label className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${item.label.toLowerCase()}…`} /></label><select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}><option>All areas</option>{areas.map((area) => <option key={area}>{area}</option>)}</select><span className="toolbar-count">{tasks.length} items</span></div>
    <section className="task-list" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/workboard-task"); if (id) onReorder(id, null, view); }}>{tasks.length ? tasks.map((task) => <TaskRow key={task.id} task={task} onToggle={onToggle} onMove={onMove} onRole={onRole} onReorder={onReorder} onExpand={onExpand} expandedTask={expandedTask} />) : <div className="empty-state"><Inbox size={23} /><strong>Nothing in this vertical.</strong><span>Drop a card here to move it into this vertical.</span></div>}</section>
  </div>;
}

function TaskRow({ task, onToggle, onMove, onRole, onReorder, onExpand, expandedTask }: { task: Task; onToggle: (id: string) => void; onMove: (id: string, container: Container) => void; onRole?: (id: string, role: Role) => void; onReorder?: (id: string, targetId: string | null, targetContainer: Container) => void; onExpand: (id: string | null) => void; expandedTask: string | null }) {
  const expanded = expandedTask === task.id;
  return <div draggable={Boolean(onReorder)} className={`task-row ${task.completed ? "completed" : ""} ${expanded ? "expanded" : ""}`} title={onReorder ? "Drag to reorder or move" : undefined} onDragStart={(event) => { if (!onReorder) return; event.dataTransfer.setData("text/workboard-task", task.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (onReorder) { event.preventDefault(); event.stopPropagation(); } }} onDrop={(event) => { if (!onReorder) return; event.preventDefault(); event.stopPropagation(); const id = event.dataTransfer.getData("text/workboard-task"); if (id) onReorder(id, task.id, task.container); }}>
    <div className="task-row-main"><button className={`check-box ${task.completed ? "checked" : ""}`} onClick={() => onToggle(task.id)} aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`}>{task.completed && <Check size={14} />}</button><button className="task-title" onClick={() => onExpand(expanded ? null : task.id)}>{task.title}</button>{task.priority === "high" && <span className="high-label">HIGH</span>}<span className="task-area">{task.area}</span>{task.due && <span className={`task-due ${task.due === "Today" ? "due-now" : ""}`}>{task.due}</span>}<button className="row-more" onClick={() => onExpand(expanded ? null : task.id)} aria-label="Open task details"><MoreHorizontal size={18} /></button></div>
    <div className="task-row-meta"><span>{task.source}</span>{task.project && <><span className="meta-sep">/</span><span>{task.project}</span></>}{task.completed && <span className="completion-date">Done {task.completedAt}</span>}<label className="move-control">Move to <TaskDestinationSelect task={task} onMove={onMove} onRole={(id, role) => onRole?.(id, role)} ariaLabel={`Move ${task.title}`} /></label></div>
    {expanded && <div className="task-detail"><div><span className="eyebrow">DETAIL</span><p>{task.notes ?? "No notes excerpt. Source context can be linked here when providers are connected."}</p></div><div className="detail-links"><span><ExternalLink size={14} /> Open {task.source}</span><span><BookOpen size={14} /> Add Obsidian context</span></div>{task.waitingOn && <div className="waiting-note"><Clock3 size={14} /> Waiting on: {task.waitingOn}</div>}</div>}
  </div>;
}

function ProjectsView({ tasks, selectedProject, setSelectedProject, onToggle }: { tasks: Task[]; selectedProject: string; setSelectedProject: (id: string) => void; onToggle: (id: string) => void }) {
  const project = projects.find((item) => item.id === selectedProject) ?? projects[0];
  const projectTasks = tasks.filter((task) => task.project === project.name);
  return <div className="content-wrap projects-page"><PageHeader eyebrow="WORK BOARD / PROJECTS" title="Active projects" description="Outcomes with more than one action. Every active project needs a next action." actions={<button className="button primary"><Plus size={16} /> New project</button>} />
    <div className="project-layout"><div className="project-list">{projects.map((item) => { const count = tasks.filter((task) => task.project === item.name).length; return <button key={item.id} className={`project-card ${item.id === selectedProject ? "selected" : ""}`} onClick={() => setSelectedProject(item.id)}><div className="project-card-top"><span className={`status-dot ${item.status.replace(" ", "-")}`} /> <span className="status-label">{item.status}</span><span className="project-code">{item.id.toUpperCase()}</span></div><h2>{item.name}</h2><p>{item.outcome}</p><div className="project-card-foot"><span><Check size={14} /> {tasks.filter((task) => task.project === item.name && task.completed).length}/{count} tasks</span><span>{item.area}</span></div></button>; })}</div>
      <section className="project-detail"><div className="detail-header"><div><span className="eyebrow">{project.id.toUpperCase()} / {project.status.toUpperCase()}</span><h2>{project.name}</h2></div><button className="icon-button"><ExternalLink size={17} /></button></div><div className="project-outcome"><span className="eyebrow">OUTCOME / OBJECTIVE</span><p>{project.outcome}</p></div><div className="project-detail-grid"><div><div className="section-heading compact"><h3>Next actions</h3><span className="mono muted">{projectTasks.filter((task) => !task.completed).length} active</span></div>{projectTasks.length ? <div className="project-task-list">{projectTasks.map((task) => <div className={`project-task ${task.completed ? "done" : ""}`} key={task.id}><button className={`check-box ${task.completed ? "checked" : ""}`} onClick={() => onToggle(task.id)}>{task.completed && <Check size={14} />}</button><span>{task.title}</span></div>)}</div> : <div className="empty-state small">No linked tasks yet.</div>}</div><aside className="linked-context"><div className="eyebrow"><BookOpen size={14} /> LINKED CONTEXT</div><div className="context-card"><BookOpen size={15} /><span>{project.note}</span><ExternalLink size={14} /></div><p className="muted small-copy">Obsidian notes stay read-only and are opened at the source.</p></aside></div></section></div>
  </div>;
}

function AttentionQueueView({ signals, statuses, navigate, onStatus }: { signals: AttentionSignal[]; statuses: Record<string, AttentionStatus>; navigate: (view: View) => void; onStatus: (signal: AttentionSignal, status: AttentionStatus) => void }) {
  const openSignals = signals.filter((signal) => !["attended", "dismissed"].includes(statuses[signal.id] ?? "open"));
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const categoryOrder: AttentionSignal["category"][] = ["communication", "focus", "overdue", "backlog", "dependency"];
  const categoryLabels: Record<AttentionSignal["category"], string> = { communication: "Communications", focus: "Focus", overdue: "Overdue commitments", backlog: "Planning backlog", dependency: "Waiting and dependencies" };
  const groupedSignals = categoryOrder.map((category) => ({ category, label: categoryLabels[category], signals: openSignals.filter((signal) => signal.category === category) })).filter((group) => group.signals.length > 0);
  const toggleCategory = (category: AttentionSignal["category"]) => setExpandedCategories((current) => ({ ...current, [category]: !current[category] }));
  const renderSignal = (signal: AttentionSignal) => {
    const status = statuses[signal.id] ?? "open";
    return <article className={`attention-card ${signal.severity}`} key={signal.id}><div className="attention-card-top"><span className="eyebrow">{signal.category} · {signal.severity}</span><span className="attention-status">{status}</span></div><h2>{signal.title}</h2><p>{signal.detail}</p><div className="attention-card-foot">{signal.sourceUrl ? <a className="button outline small" href={signal.sourceUrl} target="_blank" rel="noreferrer">{signal.actionLabel} <ExternalLink size={13} /></a> : <button className="button outline small" onClick={() => navigate(signal.targetView)}>{signal.actionLabel} <ArrowRight size={13} /></button>}<div className="attention-actions"><button className="text-button" onClick={() => onStatus(signal, "attended")}>Mark attended</button><button className="text-button" onClick={() => onStatus(signal, "deferred")}>Defer</button><button className="text-button" onClick={() => onStatus(signal, "dismissed")}>Dismiss</button></div></div></article>;
  };
  return <div className="content-wrap attention-page"><PageHeader eyebrow="CHIEF OF STAFF / ATTENTION QUEUE" title="Bring the important things forward." description="A local WorkBoard Sentinel reviews focus, overdue work, backlog, and dependencies. Nothing is changed automatically." actions={<button className="button dark" onClick={() => window.location.reload()}><RefreshCw size={15} /> Run review</button>} />
    <section className="attention-banner"><div className="attention-score"><span>{openSignals.length}</span><small>open signals</small></div><div><strong>Chief of Staff review queue</strong><p>Review each signal, then mark it attended, defer it, or dismiss it locally.</p></div></section>
    {groupedSignals.length ? <div className="attention-categories">{groupedSignals.map((group) => { const expanded = Boolean(expandedCategories[group.category]); return <section className="attention-category" key={group.category}><button className="attention-category-header" aria-expanded={expanded} onClick={() => toggleCategory(group.category)}><span><strong>{group.label}</strong><small>{group.category === "communication" ? "Email signals" : "Chief of Staff review signals"}</small></span><span className="attention-category-count">{group.signals.length}</span><ChevronDown size={18} /></button>{expanded && <div className="attention-category-list">{group.signals.map(renderSignal)}</div>}</section>; })}</div> : <div className="empty-state"><Sparkles size={23} /><strong>No open signals.</strong><span>The WorkBoard Sentinel has nothing new to bring forward.</span></div>}
  </div>;
}

function ReviewView({ tasks, navigate, onMove }: { tasks: Task[]; navigate: (view: View) => void; onMove: (id: string, container: Container) => void }) {
  const queues = [
    { label: "Unassigned capture", count: tasks.filter((task) => task.area === "Unassigned").length, detail: "Planning Repository items without an area or project", action: "planning_repository" as View },
    { label: "Today closeout", count: tasks.filter((task) => task.container === "today" && !task.completed).length, detail: "Incomplete daily commitments requiring a decision", action: "today" as View },
    { label: "Waiting without follow-up", count: tasks.filter((task) => task.container === "waiting_for" && !task.due).length, detail: "Dependencies that need a date to come back to", action: "waiting_for" as View },
    { label: "Stale commitments", count: 3, detail: "Tasks not touched in the last 14 or 30 days", action: "this_week" as View },
    { label: "Projects without a next action", count: 1, detail: "Active outcomes with no clear active task", action: "projects" as View },
    { label: "Legacy Today migration", count: 6, detail: "Imported parent relationships needing an intentional decision", action: "planning_repository" as View },
  ];
  return <div className="content-wrap review-page"><PageHeader eyebrow="WORK OS / WEEKLY REVIEW" title="Review the system." description="Evidence over guilt. Make small, reversible decisions that keep the board trustworthy." actions={<button className="button dark"><RefreshCw size={15} /> Sync preview</button>} /><section className="review-banner"><div className="review-score"><span className="score-number">7</span><span>open review<br />signals</span></div><div><strong>Last reviewed 4 days ago</strong><p>Nothing will be completed, deleted, or moved in bulk from this screen.</p></div></section><div className="review-grid">{queues.map((queue) => <button className="review-card" key={queue.label} onClick={() => navigate(queue.action)}><div className="review-card-top"><span className="eyebrow">QUEUE</span><span className={`queue-count ${queue.count ? "has-items" : ""}`}>{queue.count}</span></div><h2>{queue.label}</h2><p>{queue.detail}</p><span className="review-action">Open queue <ArrowRight size={14} /></span></button>)}</div><section className="review-guardrail"><CircleHelp size={16} /><span>Review actions are local metadata changes until you explicitly choose a provider write-back.</span></section></div>;
}

function SettingsView({ flash, obsidianPreview, savedObsidianVault, onObsidianFiles, onObsidianDirectoryPick, onObsidianDisconnect, googleTasksPreview, googleTasksConnected, googleTasksConnecting, demoTaskCount, onClearDemoTasks, onGoogleTasksPreview, onGoogleTasksConnect, onGoogleTasksRefresh, gmailScan, gmailError, gmailConnected, gmailConnecting, onGmailConnect, onGmailScan, onOpenAttention, googleClientId, onGoogleClientIdChange, onSaveGoogleClientId, notionStatus, notionReferences, notionResults, notionQuery, notionSearching, onNotionConnect, onNotionQueryChange, onNotionSearch, onNotionAddReference, onNotionRemoveReference }: { flash: (message: string) => void; obsidianPreview: ObsidianVaultPreview | null; savedObsidianVault: SavedObsidianVault | null; onObsidianFiles: (files: FileList | null) => void; onObsidianDirectoryPick: () => void; onObsidianDisconnect: () => void; googleTasksPreview: GoogleTasksPreview | null; googleTasksConnected: boolean; googleTasksConnecting: boolean; demoTaskCount: number; onClearDemoTasks: () => void; onGoogleTasksPreview: () => void; onGoogleTasksConnect: () => void; onGoogleTasksRefresh: () => void; gmailScan: GmailScan | null; gmailError: string | null; gmailConnected: boolean; gmailConnecting: boolean; onGmailConnect: () => void; onGmailScan: () => void; onOpenAttention: () => void; googleClientId: string; onGoogleClientIdChange: (value: string) => void; onSaveGoogleClientId: () => void; notionStatus: NotionConnectionStatus; notionReferences: NotionReference[]; notionResults: NotionReference[]; notionQuery: string; notionSearching: boolean; onNotionConnect: () => void; onNotionQueryChange: (value: string) => void; onNotionSearch: () => void; onNotionAddReference: (reference: NotionReference) => void; onNotionRemoveReference: (id: string) => void }) {
  const obsidianInput = useRef<HTMLInputElement>(null);
  const [showGoogleTasks, setShowGoogleTasks] = useState(false);
  useEffect(() => { obsidianInput.current?.setAttribute("webkitdirectory", ""); }, []);
  return (
    <div className="content-wrap settings-page">
      <PageHeader eyebrow="WORK OS / SETTINGS" title="Make the system yours." description="Connections are deliberately scoped. The browser foundation never writes to your sources." actions={<button className="button primary" onClick={() => flash("Settings saved locally")}>Save settings</button>} />
      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card-heading">
            <div className="settings-icon"><UsersRound size={19} /></div>
            <div><h2>Google Tasks</h2><p>Commitments source</p></div>
            <span className={googleTasksConnecting ? "connection-state connecting" : googleTasksConnected ? "connection-state connected" : googleTasksPreview ? "connection-state" : "connection-state"}>{googleTasksConnecting ? "LOADING…" : googleTasksConnected ? "CONNECTED" : googleTasksPreview ? "PREVIEW READY" : "NOT CONNECTED"}</span>
          </div>
          {googleTasksConnected || googleTasksPreview ? (
            <>
              <div className="google-preview-status"><strong>{googleTasksPreview?.accountLabel ?? "Connected Google Tasks account"}</strong><span>{googleTasksPreview ? `${googleTasksPreview.tasks.length} records · ${googleTasksPreview.mode === "live" ? "read-only live" : "dry-run only"}` : "Restoring saved connection…"}</span></div>
              {googleTasksPreview && <div className="google-task-preview">
                {googleTasksPreview.tasks.slice(0, showGoogleTasks ? undefined : 5).map((task) => <article className="google-task-item" key={task.sourceKey}><div><strong>{task.title}</strong><span>{task.listName}{task.due ? " · due " + task.due : ""}</span></div><span className={task.completed ? "google-task-state done" : "google-task-state"}>{task.completed ? "DONE" : "OPEN"}</span></article>)}
              </div>}
              {googleTasksPreview && googleTasksPreview.tasks.length > 5 && <button className="text-button google-task-toggle" onClick={() => setShowGoogleTasks((current) => !current)}>{showGoogleTasks ? "Collapse tasks" : `Show all ${googleTasksPreview.tasks.length} tasks`}</button>}
              <div className="settings-actions"><button className="button outline small" onClick={onGoogleTasksConnect} disabled={googleTasksConnecting}>{googleTasksConnecting ? "Connecting…" : googleTasksConnected ? "Reconnect Google account" : "Connect Google account"}</button><button className="button outline small" onClick={googleTasksConnected ? onGoogleTasksRefresh : onGoogleTasksPreview} disabled={googleTasksConnecting}>{googleTasksConnecting ? "Loading…" : googleTasksConnected ? "Refresh tasks" : "Refresh preview"}</button><span className="settings-copy compact-copy">{googleTasksConnected ? "Google tokens are kept securely by WorkBoard and refreshed when needed." : "Demo data only · no provider writes."}</span></div>
              {googleTasksConnected && demoTaskCount > 0 && <div className="settings-actions"><span className="settings-copy compact-copy">{demoTaskCount} starter cards are still on this local board.</span><button className="button outline small" onClick={onClearDemoTasks}>Clear demo cards</button></div>}
            </>
          ) : (
            <>
              <div className="google-setup-actions"><a href="https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid" target="_blank" rel="noreferrer">Open Google setup guide</a><button className="button outline small" onClick={onGoogleTasksPreview}>Preview demo data</button></div>
              <div className="settings-field"><label>Paste your Google setup code</label><div className="fake-input google-client-input"><input value={googleClientId} onChange={(event) => onGoogleClientIdChange(event.target.value)} placeholder="Paste the client ID from Google" aria-label="Google client ID" /><button className="button outline small" onClick={onSaveGoogleClientId}>Save</button></div></div>
              <div className="settings-actions"><button className="button dark" onClick={onGoogleTasksConnect} disabled={googleTasksConnecting}>{googleTasksConnecting ? "Connecting…" : "Connect Google Tasks"}</button></div>
              <div className="settings-field"><label>Selected lists</label><div className="tag-row"><span className="tag">Planning Repository</span><span className="tag">This Week</span><button className="text-button">Edit selection</button></div></div>
              <p className="settings-copy">Google authorization is handled securely by WorkBoard. Your Google password and tokens never enter this page.</p>
            </>
          )}
        </section>
        <section className="settings-card gmail-settings-card">
          <div className="settings-card-heading"><div className="settings-icon"><Bell size={19} /></div><div><h2>Communications Scout</h2><p>Read-only Gmail intelligence</p></div><span className={`connection-state ${gmailConnected ? "connected" : ""}`}>{gmailConnecting ? "SCANNING…" : gmailConnected ? "CONNECTED" : "NOT CONNECTED"}</span></div>
          {gmailConnected ? <>
            <div className="google-preview-status"><strong>{gmailScan?.accountLabel ?? "Connected Gmail account"}</strong><span>{gmailScan ? `${gmailScan.candidates.length} candidate emails · checked ${new Date(gmailScan.scannedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Restoring saved connection…"}</span></div>
            {gmailError && <p className="settings-copy gmail-scan-error">The connection is saved, but the email check failed: {gmailError}</p>}
            {gmailScan && <div className="gmail-candidate-list">{gmailScan.candidates.length ? gmailScan.candidates.slice(0, 5).map((candidate) => <article className="gmail-candidate" key={candidate.id}><div><strong>{candidate.kind === "sent_follow_up" ? "FOLLOW UP" : "INCOMING"} · {candidate.subject}</strong><span>{candidate.sender} · {candidate.date}</span></div><a href={candidate.sourceUrl} target="_blank" rel="noreferrer">OPEN</a></article>) : <p className="settings-copy compact-copy">No follow-ups or important incoming messages matched the last-seven-day scan.</p>}</div>}
            <div className="settings-actions gmail-actions"><button className="button outline small" onClick={onGmailScan} disabled={gmailConnecting}>{gmailConnecting ? "Checking…" : "Check Gmail now"}</button><button className="button outline small" onClick={onOpenAttention}>Open Attention Queue</button></div>
            <p className="settings-copy">The Communications Scout reads message metadata and snippets only. Results appear here and in the Chief of Staff Attention Queue. It never sends, deletes, archives, or changes email.</p>
          </> : <>
            <p className="settings-copy">Find sent messages from the past seven days that may need follow-up, plus important incoming mail while filtering obvious marketing and bulk traffic.</p>
            {gmailError && <p className="settings-copy gmail-scan-error">{gmailError}</p>}
            <div className="settings-actions gmail-actions"><button className="button dark" onClick={onGmailConnect} disabled={gmailConnecting}>{gmailConnecting ? "Connecting…" : "Connect Gmail read-only"}</button></div>
          </>}
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <div className="settings-icon"><BookOpen size={19} /></div>
            <div><h2>Obsidian vault</h2><p>Read-only context source</p></div>
            <span className={obsidianPreview ? "connection-state connected" : "connection-state"}>{obsidianPreview ? "CONNECTED" : "NOT CONNECTED"}</span>
          </div>
          {obsidianPreview ? (
            <>
              <div className="obsidian-connected"><div><strong>{obsidianPreview.vaultName}</strong><span>{obsidianPreview.noteCount} Markdown notes loaded for this session</span></div><button className="button outline small" onClick={onObsidianDisconnect}>Disconnect</button></div>
              <div className="obsidian-preview">{obsidianPreview.notes.slice(0, 3).map((note) => <article className="obsidian-note" key={note.sourceId}><div><strong>{note.title}</strong><span>{note.path}</span></div><p>{note.excerpt}</p>{note.tags.length > 0 && <div className="tag-row">{note.tags.map((tag) => <span className="tag muted-tag" key={tag}>#{tag}</span>)}</div>}</article>)}{obsidianPreview.notes.length === 0 && <p className="settings-copy">No Markdown notes found in this folder.</p>}</div>
              <p className="settings-copy">The vault selection is saved locally. Notes stay in memory for this session; the vault is never edited and note contents are not written to local storage.</p>
            </>
          ) : (
            <>
              <div className="settings-field"><label>Vault path</label><div className="fake-input">{savedObsidianVault ? <span>{savedObsidianVault.vaultName} · saved locally</span> : <span>Choose a local folder</span>}<button className="button outline small" onClick={() => window.showDirectoryPicker ? onObsidianDirectoryPick() : obsidianInput.current?.click()}>Choose</button></div><input ref={obsidianInput} className="visually-hidden" type="file" multiple onChange={(event) => onObsidianFiles(event.target.files)} /></div>
              <div className="settings-field"><label>Ignored folders</label><div className="tag-row"><span className="tag muted-tag">.obsidian</span><span className="tag muted-tag">templates</span><span className="tag muted-tag">attachments</span></div></div>
              <p className="settings-copy">{savedObsidianVault ? "Choose the saved folder again to reload its Markdown preview after this browser session." : "Select a vault folder to preview Markdown context."} This connection is read-only.</p>
            </>
          )}
        </section>
        <section className="settings-card">
          <div className="settings-card-heading"><div className="settings-icon"><Archive size={19} /></div><div><h2>Notion references</h2><p>Scoped, read-only context</p></div><span className={`connection-state ${notionStatus.connected ? "connected" : ""}`}>{notionStatus.connected ? "CONNECTED" : notionStatus.configured ? "READY TO CONNECT" : "SETUP NEEDED"}</span></div>
          {notionStatus.connected ? <>
            <div className="google-preview-status"><strong>{notionStatus.workspaceName ?? "Connected Notion workspace"}</strong><span>{notionReferences.length} local reference{notionReferences.length === 1 ? "" : "s"} selected</span></div>
            <div className="settings-field"><label>Search shared pages or databases</label><div className="fake-input google-client-input"><input value={notionQuery} onChange={(event) => onNotionQueryChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onNotionSearch()} placeholder="Search Notion…" aria-label="Notion search" /><button className="button outline small" onClick={onNotionSearch} disabled={notionSearching}>{notionSearching ? "Searching…" : "Search"}</button></div></div>
            {notionResults.length > 0 && <div className="notion-reference-list">{notionResults.map((reference) => { const selected = notionReferences.some((item) => item.id === reference.id); return <div className={`notion-reference-item ${selected ? "selected" : ""}`} key={reference.id}><div><strong>{reference.title}</strong><span>{selected ? "Scoped locally" : reference.kind}</span></div><button className={`button ${selected ? "success" : "outline"} small`} onClick={() => onNotionAddReference(reference)} disabled={selected}>{selected ? "Scoped" : "Add scope"}</button></div>; })}</div>}
            {notionReferences.length > 0 && <div className="settings-field"><label>Selected scopes</label><div className="notion-reference-list">{notionReferences.map((reference) => <div className="notion-reference-item" key={reference.id}><div><strong>{reference.title}</strong><span>{reference.kind}</span></div><button className="text-button" onClick={() => onNotionRemoveReference(reference.id)}>Remove</button></div>)}</div></div>}
            <p className="settings-copy">Only selected references are indexed. Notion content never becomes an active work card automatically.</p>
          </> : <>
            <p className="settings-copy">Connect a Notion public connection, then choose specific pages or databases. Notion references never become active work cards.</p>
            <div className="google-setup-actions"><a href="https://developers.notion.com/guides/get-started/authorization" target="_blank" rel="noreferrer">Open Notion authorization guide</a><button className="button dark" onClick={onNotionConnect} disabled={!notionStatus.configured}>Connect Notion <ExternalLink size={14} /></button></div>
            <p className="settings-copy">{notionStatus.configured ? "Ready for read-only OAuth." : "Add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET to .env.local, then restart the dev server."}</p>
          </>}
        </section>
        <section className="settings-card">
          <div className="settings-card-heading"><div className="settings-icon"><RefreshCw size={19} /></div><div><h2>Sync & backup</h2><p>Safe local operations</p></div></div>
          <div className="sync-status"><span className="live-indicator" /><span>Ready for a read-only sync preview</span></div>
          <div className="settings-actions"><button className="button dark" onClick={() => flash("Dry-run sync preview complete · no provider writes")}>Run dry-run sync</button><button className="button outline" onClick={() => flash("Local backup export staged")}>Export local data</button></div>
        </section>
      </div>
    </div>
  );
}

export default App;
