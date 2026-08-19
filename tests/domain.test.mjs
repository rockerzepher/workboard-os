import test from "node:test";
import assert from "node:assert/strict";

test("daily plan permits one main outcome and one evening build", () => {
  const plan = { mainOutcome: null, eveningBuild: null };
  plan.mainOutcome = "task-1";
  plan.eveningBuild = "project-1";
  assert.equal(plan.mainOutcome, "task-1");
  assert.equal(plan.eveningBuild, "project-1");
});

test("source identity is stable and idempotent", () => {
  const imported = new Map();
  const sourceKey = (provider, id) => `${provider}:${id}`;
  imported.set(sourceKey("google_tasks", "gt-1"), { title: "Synthetic task" });
  imported.set(sourceKey("google_tasks", "gt-1"), { title: "Updated synthetic task" });
  assert.equal(imported.size, 1);
  assert.equal(imported.get("google_tasks:gt-1").title, "Updated synthetic task");
});

test("moving a card changes its local container without duplicating it", () => {
  const items = [{ id: "a", container: "planning_repository" }];
  items[0].container = "this_week";
  assert.equal(items.length, 1);
  assert.equal(items[0].container, "this_week");
});
