// Decides what the AI panel shows once a run's terminal has ended. md/err are the file contents or null.
// cleanup: remove the partial files. <hash>.md is only ever created whole (atomic move), so a timeout that lost the race keeps it.
export function explainOutcome({ reason, timedOut, md, err }) {
  if (reason && !(timedOut && md)) return { error: reason, cleanup: true };
  if (md) return { text: md };
  return { error: err || "Claude 沒有產生結果，也沒有錯誤訊息" };
}

// Kills every live explain run, then removes its partial files. Each run is handled alone so one failure never spares the rest.
// Kill comes first (hc get also works on a finished terminal); no hash means the files are left alone and a warning is raised.
// deps (all return promises): kill(address), labels(address), removeTmp(hash), warn(message, error)
export async function reapRuns(live, { kill, labels, removeTmp, warn }) {
  for (const { address } of live) {
    try {
      await kill(address);
      const hash = (await labels(address))["git-graph.hash"];
      if (!hash) { warn(`no git-graph.hash label on ${address}, partial files left`); continue; }
      await removeTmp(hash);
    } catch (e) { warn(`cannot reap explain run ${address}:`, e); }
  }
}
