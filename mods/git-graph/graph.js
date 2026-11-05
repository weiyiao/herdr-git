// Lane assignment for a commit graph. Input: [{hash, parents}] in `git log --topo-order` order.
// Output per row: { lane, color, width, lines }. A line is { a, b, half, color }:
// half 0 runs from (lane a, row top) to (lane b, row middle); half 1 from (a, middle) to (b, bottom).
export function layoutGraph(commits) {
  let lanes = []; // { hash, color } | null: the commit each lane is waiting for
  let next = 0;
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  return commits.map(({ hash, parents }) => {
    const lines = [], before = lanes.length;
    let lane = lanes.findIndex((l) => l?.hash === hash);
    const color = lane < 0 ? next++ : lanes[lane].color;
    if (lane < 0) lane = free();
    lanes.forEach((l, i) => {
      if (!l) return;
      if (l.hash === hash) lines.push({ a: i, b: lane, half: 0, color: l.color });
      else lines.push({ a: i, b: i, half: 0, color: l.color });
    });
    // Lanes that waited for this commit end here; the first parent continues in `lane`.
    const after = lanes.map((l) => (l?.hash === hash ? null : l));
    if (parents.length) after[lane] = { hash: parents[0], color };
    else after[lane] = null;
    for (const p of parents.slice(1)) {
      let t = after.findIndex((l) => l?.hash === p);
      if (t < 0) { t = after.indexOf(null); if (t < 0) t = after.length; after[t] = { hash: p, color: next++ }; }
      lines.push({ a: lane, b: t, half: 1, color: after[t].color });
    }
    after.forEach((l, i) => {
      if (!l) return;
      if (i === lane && parents.length) lines.push({ a: lane, b: lane, half: 1, color });
      else if (i !== lane && lanes[i] === l) lines.push({ a: i, b: i, half: 1, color: l.color });
    });
    while (after.length && after[after.length - 1] === null) after.pop();
    lanes = after;
    return { lane, color, width: Math.max(before, after.length, lane + 1, ...lines.map((l) => l.b + 1)), lines };
  });
}
