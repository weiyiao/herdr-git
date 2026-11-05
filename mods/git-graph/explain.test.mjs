import assert from "node:assert/strict";
import { explainOutcome, reapRuns } from "./explain.js";

const TIMEOUT = "逾時：Claude 超過 3 分鐘沒有完成，已自動結束", CANCEL = "已取消";

// timeout fired but claude had already finished: the complete result wins and the file stays
assert.deepEqual(explainOutcome({ reason: TIMEOUT, timedOut: true, md: "# done", err: null }), { text: "# done" });

// timeout with no result: timeout error, partial files removed
assert.deepEqual(explainOutcome({ reason: TIMEOUT, timedOut: true, md: null, err: null }), { error: TIMEOUT, cleanup: true });

// user cancel is final even when a result exists
assert.deepEqual(explainOutcome({ reason: CANCEL, timedOut: false, md: "# done", err: null }), { error: CANCEL, cleanup: true });

// normal runs
assert.deepEqual(explainOutcome({ md: "# ok", err: null }), { text: "# ok" });
assert.deepEqual(explainOutcome({ md: null, err: "exit code 1" }), { error: "exit code 1" });
assert.deepEqual(explainOutcome({ md: null, err: null }), { error: "Claude 沒有產生結果，也沒有錯誤訊息" });

// reapRuns: one terminal failing must not spare the others
const live = ["t1", "t2", "t3"].map((address) => ({ address }));
const harness = ({ failKill, failLabels, noHash } = {}) => {
  const killed = [], removed = [], warned = [];
  return {
    killed, removed, warned,
    deps: {
      kill: async (a) => { if (a === failKill) throw new Error("kill failed"); killed.push(a); },
      labels: async (a) => { if (a === failLabels) throw new Error("bad json"); return noHash === a ? {} : { "git-graph.hash": `h-${a}` }; },
      removeTmp: async (h) => { removed.push(h); },
      warn: (...args) => warned.push(args),
    },
  };
};

{ // happy path
  const h = harness();
  await reapRuns(live, h.deps);
  assert.deepEqual(h.killed, ["t1", "t2", "t3"]);
  assert.deepEqual(h.removed, ["h-t1", "h-t2", "h-t3"]);
  assert.equal(h.warned.length, 0);
}

{ // labels rejects for the first terminal: all are killed, the other two are cleaned
  const h = harness({ failLabels: "t1" });
  await reapRuns(live, h.deps);
  assert.deepEqual(h.killed, ["t1", "t2", "t3"]);
  assert.deepEqual(h.removed, ["h-t2", "h-t3"]);
  assert.equal(h.warned.length, 1);
}

{ // no git-graph.hash label: still killed, removeTmp never gets undefined
  const h = harness({ noHash: "t2" });
  await reapRuns(live, h.deps);
  assert.deepEqual(h.killed, ["t1", "t2", "t3"]);
  assert.deepEqual(h.removed, ["h-t1", "h-t3"]);
  assert.equal(h.warned.length, 1);
}

{ // kill rejects for one terminal: the others are still killed and cleaned
  const h = harness({ failKill: "t2" });
  await reapRuns(live, h.deps);
  assert.deepEqual(h.killed, ["t1", "t3"]);
  assert.deepEqual(h.removed, ["h-t1", "h-t3"]);
}

console.log("explain tests passed");
