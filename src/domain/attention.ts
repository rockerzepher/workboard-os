export type SentinelTask = {
  id: string;
  title: string;
  container: string;
  area: string;
  priority: "low" | "normal" | "high";
  due?: string;
  completed: boolean;
  role?: "quick_clear" | "main_outcome" | "evening_build" | null;
};

export type AttentionSeverity = "high" | "medium" | "low";
export type AttentionStatus = "open" | "attended" | "deferred" | "dismissed";
export type AttentionView = "planning_repository" | "today" | "this_week" | "projects" | "waiting_for";

export type AttentionSignal = {
  id: string;
  category: "focus" | "overdue" | "backlog" | "dependency" | "communication";
  severity: AttentionSeverity;
  title: string;
  detail: string;
  taskIds: string[];
  targetView: AttentionView;
  actionLabel: string;
  sourceUrl?: string;
};

function isPastDate(value: string | undefined, today: string) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && value < today);
}

function taskExamples(tasks: SentinelTask[]) {
  const examples = tasks.slice(0, 3).map((task) => `“${task.title}”`);
  return examples.length ? ` Examples: ${examples.join(", ")}.` : "";
}

export function inspectWorkboard(tasks: SentinelTask[], now = new Date()): AttentionSignal[] {
  const today = now.toISOString().slice(0, 10);
  const openTasks = tasks.filter((task) => !task.completed);
  const signals: AttentionSignal[] = [];
  const overdue = openTasks.filter((task) => isPastDate(task.due, today));
  const waiting = openTasks.filter((task) => task.container === "waiting_for");
  const unassignedCapture = openTasks.filter((task) => task.container === "planning_repository" && task.area === "Unassigned");
  const activeToday = openTasks.filter((task) => task.container === "today");
  const mainOutcome = activeToday.find((task) => task.role === "main_outcome");
  const highOutsideFocus = openTasks.filter((task) => task.priority === "high" && !["today", "this_week"].includes(task.container));

  if (!mainOutcome) {
    signals.push({
      id: "today-main-outcome-missing",
      category: "focus",
      severity: "high",
      title: "Today has no active main outcome",
      detail: "The Chief of Staff should help choose one outcome before the day gets crowded.",
      taskIds: activeToday.map((task) => task.id),
      targetView: "today",
      actionLabel: "Review Today",
    });
  }

  if (overdue.length) {
    signals.push({
      id: "overdue-commitments",
      category: "overdue",
      severity: "high",
      title: `${overdue.length} open commitment${overdue.length === 1 ? " is" : "s are"} past due`,
      detail: `Review the dates, move the work, or deliberately defer it.${taskExamples(overdue)}`,
      taskIds: overdue.map((task) => task.id),
      targetView: "this_week",
      actionLabel: "Review overdue",
    });
  }

  if (unassignedCapture.length >= 5) {
    signals.push({
      id: "planning-backlog",
      category: "backlog",
      severity: unassignedCapture.length >= 25 ? "high" : "medium",
      title: `${unassignedCapture.length} captured items have no area`,
      detail: "The Planning Repository is becoming a holding pen. The next review should sort, schedule, or dismiss the oldest items.",
      taskIds: unassignedCapture.map((task) => task.id),
      targetView: "planning_repository",
      actionLabel: "Review capture",
    });
  }

  if (waiting.length) {
    const undated = waiting.filter((task) => !task.due);
    signals.push({
      id: "waiting-for-review",
      category: "dependency",
      severity: undated.length ? "medium" : "low",
      title: `${waiting.length} item${waiting.length === 1 ? " is" : "s are"} waiting on someone else`,
      detail: undated.length ? `${undated.length} waiting item${undated.length === 1 ? " has" : "s have"} no follow-up date.` : "Confirm the next follow-up dates so dependencies do not disappear.",
      taskIds: waiting.map((task) => task.id),
      targetView: "waiting_for",
      actionLabel: "Review waiting",
    });
  }

  if (highOutsideFocus.length) {
    signals.push({
      id: "high-priority-outside-focus",
      category: "focus",
      severity: "medium",
      title: `${highOutsideFocus.length} high-priority item${highOutsideFocus.length === 1 ? " is" : "s are"} outside active focus`,
      detail: `Decide whether to promote the work into Today or This Week.${taskExamples(highOutsideFocus)}`,
      taskIds: highOutsideFocus.map((task) => task.id),
      targetView: "planning_repository",
      actionLabel: "Review priorities",
    });
  }

  return signals;
}
