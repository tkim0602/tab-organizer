import assert from "node:assert/strict";
import test from "node:test";

import { buildApplyPlanFromPreview, buildCrossWindowPlan, buildWindowPlan } from "../src/shared/organizer.js";

function tab(overrides) {
  return {
    id: overrides.id,
    index: overrides.index,
    pinned: false,
    title: "",
    url: "https://example.invalid",
    ...overrides
  };
}

test("buildWindowPlan excludes pinned tabs and starts organization after them", () => {
  const plan = buildWindowPlan([
    tab({ id: 1, index: 0, pinned: true, url: "https://mail.google.com" }),
    tab({ id: 2, index: 1, url: "https://github.com/a" }),
    tab({ id: 3, index: 2, url: "https://github.com/b" })
  ]);

  assert.deepEqual(plan.pinnedTabIds, [1]);
  assert.equal(plan.startIndex, 1);
  assert.equal(plan.skippedPinnedCount, 1);
  assert.equal(plan.screenedOutCount, 1);
  assert.deepEqual(plan.groups.map((group) => group.category), ["Work & Projects"]);
  assert.deepEqual(plan.groups[0].tabIds, [2, 3]);
});

test("buildWindowPlan creates groups only for categories with at least two tabs", () => {
  const plan = buildWindowPlan([
    tab({ id: 1, index: 0, url: "https://github.com/a" }),
    tab({ id: 2, index: 1, url: "https://github.com/b" }),
    tab({ id: 3, index: 2, url: "https://amazon.com/item" })
  ]);

  assert.deepEqual(plan.groups.map((group) => group.category), ["Work & Projects"]);
  assert.deepEqual(plan.singles, [
    {
      tabId: 3,
      category: "Shopping & Orders",
      originalIndex: 2
    }
  ]);
});

test("buildWindowPlan emits grouped tabs in fixed category order before singles", () => {
  const plan = buildWindowPlan([
    tab({ id: 1, index: 0, url: "https://youtube.com/watch?v=1" }),
    tab({ id: 2, index: 1, url: "https://github.com/a" }),
    tab({ id: 3, index: 2, url: "https://youtube.com/watch?v=2" }),
    tab({ id: 4, index: 3, url: "https://github.com/b" }),
    tab({ id: 5, index: 4, url: "https://reddit.com/r/test" })
  ]);

  assert.deepEqual(plan.groups.map((group) => group.category), ["Work & Projects", "Video, Music & News"]);
  assert.deepEqual(plan.orderedTabIds, [2, 4, 1, 3, 5]);
  assert.equal(plan.groupCount, 2);
  assert.equal(plan.organizedTabCount, 5);
});

test("buildWindowPlan uses AI category overrides when provided", () => {
  const plan = buildWindowPlan(
    [
      tab({ id: 1, index: 0, url: "https://github.com/a" }),
      tab({ id: 2, index: 1, url: "https://github.com/b" })
    ],
    {
      categoryOverrides: new Map([
        [1, "Learning & Reference"],
        [2, "Learning & Reference"]
      ])
    }
  );

  assert.deepEqual(plan.groups.map((group) => group.category), ["Learning & Reference"]);
  assert.deepEqual(plan.groups[0].tabIds, [1, 2]);
});

test("buildWindowPlan uses dynamic AI category order when provided", () => {
  const plan = buildWindowPlan(
    [
      tab({ id: 1, index: 0, url: "https://github.com/a" }),
      tab({ id: 2, index: 1, url: "https://figma.com/file/a" }),
      tab({ id: 3, index: 2, url: "https://airbnb.com/rooms/1" }),
      tab({ id: 4, index: 3, url: "https://maps.google.com" })
    ],
    {
      categoryOrder: ["Trip Planning", "Design Work"],
      categoryOverrides: new Map([
        [1, "Design Work"],
        [2, "Design Work"],
        [3, "Trip Planning"],
        [4, "Trip Planning"]
      ])
    }
  );

  assert.deepEqual(plan.groups.map((group) => group.category), ["Trip Planning", "Design Work"]);
  assert.deepEqual(plan.orderedTabIds, [3, 4, 1, 2]);
});

test("buildWindowPlan caps generated groups at three and leaves overflow tabs ungrouped", () => {
  const plan = buildWindowPlan(
    [
      tab({ id: 1, index: 0, url: "https://a.example/1" }),
      tab({ id: 2, index: 1, url: "https://a.example/2" }),
      tab({ id: 3, index: 2, url: "https://b.example/1" }),
      tab({ id: 4, index: 3, url: "https://b.example/2" }),
      tab({ id: 5, index: 4, url: "https://c.example/1" }),
      tab({ id: 6, index: 5, url: "https://c.example/2" }),
      tab({ id: 7, index: 6, url: "https://d.example/1" }),
      tab({ id: 8, index: 7, url: "https://d.example/2" })
    ],
    {
      categoryOrder: ["Alpha", "Beta", "Gamma", "Delta"],
      categoryOverrides: new Map([
        [1, "Alpha"],
        [2, "Alpha"],
        [3, "Beta"],
        [4, "Beta"],
        [5, "Gamma"],
        [6, "Gamma"],
        [7, "Delta"],
        [8, "Delta"]
      ])
    }
  );

  assert.deepEqual(plan.groups.map((group) => group.category), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(plan.singles, [
    {
      tabId: 7,
      category: "Delta",
      originalIndex: 6
    },
    {
      tabId: 8,
      category: "Delta",
      originalIndex: 7
    }
  ]);
});

test("buildWindowPlan ignores unusable AI category overrides", () => {
  const plan = buildWindowPlan(
    [
      tab({ id: 1, index: 0, url: "https://github.com/a" }),
      tab({ id: 2, index: 1, url: "https://github.com/b" })
    ],
    {
      categoryOverrides: new Map([[1, "!"]])
    }
  );

  assert.deepEqual(plan.groups.map((group) => group.category), ["Work & Projects"]);
});

test("buildWindowPlan screens out non-web tabs before classification and grouping", () => {
  const plan = buildWindowPlan([
    tab({ id: 1, index: 0, url: "chrome://extensions", title: "GitHub docs" }),
    tab({ id: 2, index: 1, url: "https://github.com/a" }),
    tab({ id: 3, index: 2, url: "https://github.com/b" }),
    tab({ id: 4, index: 3, url: "file:///Users/test/report.pdf" })
  ]);

  assert.deepEqual(plan.groups.map((group) => group.category), ["Work & Projects"]);
  assert.deepEqual(plan.groups[0].tabIds, [2, 3]);
  assert.deepEqual(plan.skippedTabs, [
    {
      tabId: 1,
      originalIndex: 0,
      reason: "browserPage",
      reasonLabel: "Browser page"
    },
    {
      tabId: 4,
      originalIndex: 3,
      reason: "localFile",
      reasonLabel: "Local file"
    }
  ]);
  assert.deepEqual(plan.screeningReasonCounts, {
    browserPage: 1,
    localFile: 1
  });
  assert.equal(plan.organizedTabCount, 2);
});

test("buildCrossWindowPlan consolidates eligible tabs across windows into fixed category groups", () => {
  const plan = buildCrossWindowPlan(
    [
      tab({ id: 1, windowId: 10, index: 0, pinned: true, url: "https://mail.google.com" }),
      tab({ id: 2, windowId: 10, index: 1, url: "https://youtube.com/watch?v=1" }),
      tab({ id: 3, windowId: 20, index: 0, pinned: true, url: "https://github.com/pinned" }),
      tab({ id: 4, windowId: 20, index: 1, url: "https://github.com/a" }),
      tab({ id: 5, windowId: 20, index: 2, url: "https://youtube.com/watch?v=2" }),
      tab({ id: 6, windowId: 30, index: 0, url: "https://github.com/b" })
    ],
    10
  );

  assert.equal(plan.startIndex, 1);
  assert.deepEqual(plan.groups.map((group) => group.category), ["Work & Projects", "Video, Music & News"]);
  assert.deepEqual(plan.orderedTabIds, [4, 6, 2, 5]);
  assert.deepEqual(plan.pinnedTabIds, [1, 3]);
  assert.equal(plan.skippedPinnedCount, 2);
  assert.equal(plan.organizedTabCount, 4);
});

test("buildApplyPlanFromPreview omits excluded tabs and applies renamed groups", () => {
  const applyPlan = buildApplyPlanFromPreview({
    startIndex: 1,
    groups: [
      {
        id: "group-0",
        category: "Research",
        tabIds: [1, 2, 3]
      }
    ],
    singles: [
      {
        tabId: 4,
        category: "Shopping",
        originalIndex: 4
      }
    ],
    tabDetails: {
      1: { index: 1 },
      2: { index: 2 },
      3: { index: 3 },
      4: { index: 4 }
    }
  }, {
    excludedTabIds: [2],
    renamedGroups: {
      "group-0": "AI"
    },
    liveTabIds: [1, 2, 3, 4]
  });

  assert.equal(applyPlan.startIndex, 1);
  assert.deepEqual(applyPlan.groups, [
    {
      id: "group-0",
      category: "AI",
      tabIds: [1, 3],
      originalIndexes: [1, 3]
    }
  ]);
  assert.deepEqual(applyPlan.singles, [
    {
      tabId: 4,
      category: "Shopping",
      originalIndex: 4
    }
  ]);
  assert.deepEqual(applyPlan.skippedApplyTabIds, [2]);
  assert.deepEqual(applyPlan.orderedTabIds, [1, 3, 4]);
});

test("buildApplyPlanFromPreview turns reduced one-tab groups into singles", () => {
  const applyPlan = buildApplyPlanFromPreview({
    startIndex: 0,
    groups: [
      {
        id: "group-0",
        category: "Travel",
        tabIds: [1, 2]
      }
    ],
    singles: [],
    tabDetails: {
      1: { index: 0 },
      2: { index: 1 }
    }
  }, {
    excludedTabIds: [2],
    liveTabIds: [1, 2]
  });

  assert.deepEqual(applyPlan.groups, []);
  assert.deepEqual(applyPlan.singles, [
    {
      tabId: 1,
      category: "Travel",
      originalIndex: 0
    }
  ]);
  assert.deepEqual(applyPlan.orderedTabIds, [1]);
});

test("buildApplyPlanFromPreview caps applied groups at three", () => {
  const applyPlan = buildApplyPlanFromPreview({
    startIndex: 0,
    groups: [
      { id: "group-0", category: "Alpha", tabIds: [1, 2] },
      { id: "group-1", category: "Beta", tabIds: [3, 4] },
      { id: "group-2", category: "Gamma", tabIds: [5, 6] },
      { id: "group-3", category: "Delta", tabIds: [7, 8] }
    ],
    singles: [],
    tabDetails: {
      1: { index: 0 },
      2: { index: 1 },
      3: { index: 2 },
      4: { index: 3 },
      5: { index: 4 },
      6: { index: 5 },
      7: { index: 6 },
      8: { index: 7 }
    }
  }, {
    liveTabIds: [1, 2, 3, 4, 5, 6, 7, 8]
  });

  assert.deepEqual(applyPlan.groups.map((group) => group.category), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(applyPlan.singles, [
    {
      tabId: 7,
      category: "Delta",
      originalIndex: 6
    },
    {
      tabId: 8,
      category: "Delta",
      originalIndex: 7
    }
  ]);
});
