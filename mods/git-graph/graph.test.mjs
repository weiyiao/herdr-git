import assert from "node:assert/strict";
import { layoutGraph } from "./graph.js";

const c = (hash, ...parents) => ({ hash, parents });
const has = (row, a, b, half) => row.lines.some((l) => l.a === a && l.b === b && l.half === half);

// linear: C <- B <- A stays in lane 0, one color, connected top to bottom
{
  const r = layoutGraph([c("C", "B"), c("B", "A"), c("A")]);
  assert.deepEqual(r.map((x) => x.lane), [0, 0, 0]);
  assert.equal(new Set(r.map((x) => x.color)).size, 1);
  assert.ok(!has(r[0], 0, 0, 0) && has(r[0], 0, 0, 1));
  assert.ok(has(r[1], 0, 0, 0) && has(r[1], 0, 0, 1));
  assert.ok(has(r[2], 0, 0, 0) && !has(r[2], 0, 0, 1));
}

// branch + merge: M(A,F) merges feature F into main A; both fork from R
{
  const r = layoutGraph([c("M", "A", "F"), c("F", "R"), c("A", "R"), c("R")]);
  assert.deepEqual(r.map((x) => x.lane), [0, 1, 0, 0]);
  assert.ok(has(r[0], 0, 1, 1), "merge-out to lane 1");
  assert.ok(has(r[1], 0, 0, 0) && has(r[1], 1, 1, 0), "main passes through the feature commit");
  assert.ok(has(r[3], 1, 0, 0), "feature lane converges into R");
  assert.notEqual(r[0].color, r[1].color);
}

// octopus: three parents open lanes 0, 1, 2
{
  const r = layoutGraph([c("O", "A", "B", "C"), c("A"), c("B"), c("C")]);
  assert.ok(has(r[0], 0, 1, 1) && has(r[0], 0, 2, 1));
  assert.deepEqual(r.map((x) => x.lane), [0, 0, 1, 2]);
  assert.equal(r[0].width, 3);
}

// merge into a lane that already waits for that parent: no new lane
{
  const r = layoutGraph([c("M", "A", "B"), c("B", "A"), c("A")]);
  assert.deepEqual(r.map((x) => x.lane), [0, 1, 0]);
  const r2 = layoutGraph([c("X", "A"), c("M", "B", "A"), c("B", "A"), c("A")]);
  assert.equal(r2[1].lane, 1);
  assert.ok(has(r2[1], 1, 0, 1), "merge line into the existing lane");
  assert.equal(r2[1].width, 2);
}

// root commit ends its lane; no bottom line
{
  const r = layoutGraph([c("A")]);
  assert.deepEqual(r[0].lines, []);
}

// two unrelated roots: the second lane is reused, not left dangling
{
  const r = layoutGraph([c("B", "A"), c("Z"), c("A")]);
  assert.deepEqual(r.map((x) => x.lane), [0, 1, 0]);
  assert.ok(has(r[1], 0, 0, 0) && has(r[1], 0, 0, 1), "first history passes by the second root");
  assert.ok(!has(r[1], 1, 1, 1), "root has no bottom segment");
  assert.equal(r[2].width, 1);
}
console.log("graph tests passed");
