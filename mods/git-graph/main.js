// Git graph: commit history with lanes, a commit's details and per-file diffs.
// Roles (props.role): the panel (default); "toggle", the tab-bar button that shows or hides the
// layout's "git-panel" node.
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, TextView } from "gpui-base";
import * as fs from "fs/promises";
import { spaces, panes, focused, exec, watchFolder, readTextFile, appHome, window as win, theme, settings, layout, run, props as blockProps } from "herdr";
import { layoutGraph } from "./graph.js";
import { explainOutcome, reapRuns } from "./explain.js";
import { parseFiles, diffArgs } from "./parse.js";

const PANEL = "git-panel";
const DETAIL = 340, ROW = 28, LANE = 14, MAX_COMMITS = 300;
const EXPLAIN_TIMEOUT_MS = 180000;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const stop = (_e, cx) => cx.stop_propagation();
const stamp = (at) => {
  const d = new Date(Number(at) * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

const segButton = (t, id, label, on, fn) => div().id(id).h(22).px(10).flex().items_center().rounded(5).text_size(12)
  .bg(on ? t.raised : t.chrome).text_color(on ? t.foreground : t.muted).cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => fn(cx)).child(label);

const PROMPT = (hash) => `用正體中文解釋這個 git commit 的變更：${hash}。先執行 \`git show --stat ${hash}\`，再執行 \`git show ${hash}\` 讀內容；merge commit 改用 \`git diff <first parent> ${hash}\`。只讀不改，不要修改任何檔案。用 markdown 回答，三段：## 摘要（一兩句說這個 commit 做了什麼、為什麼）、## 主要變更（依檔案或主題條列）、## 值得注意（風險、可能的 bug、遺漏的測試；沒有就寫「無」）。`;
const TOOLS = ["Bash(git show:*)", "Bash(git diff:*)", "Bash(git log:*)"];
// Runner: prompt on stdin, output to <hash>.md.tmp, then <hash>.md on success or <hash>.err on failure.
const POWERSHELL = (hash) => `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$d = $PSScriptRoot; $h = '${hash}'
$tmp = Join-Path $d "$h.md.tmp"; $log = Join-Path $d "$h.log.tmp"
try {
  Get-Content -Raw -Encoding utf8 (Join-Path $d "$h.prompt.txt") | claude -p --model sonnet --strict-mcp-config --allowedTools ${TOOLS.map((x) => `"${x}"`).join(" ")} 2> $log | Set-Content -Encoding utf8NoBOM $tmp
  $code = $LASTEXITCODE
  if ($code -eq 0 -and (Test-Path $tmp) -and (Get-Item $tmp).Length -gt 0) { Move-Item -Force $tmp (Join-Path $d "$h.md") }
  else { Set-Content -Encoding utf8NoBOM (Join-Path $d "$h.err") ("exit code $code" + [Environment]::NewLine + (Get-Content -Raw -ErrorAction SilentlyContinue $log)) }
} catch { Set-Content -Encoding utf8NoBOM (Join-Path $d "$h.err") ($_ | Out-String) }
Remove-Item $tmp, $log -ErrorAction SilentlyContinue
`;
const POSIX = (hash) => `d=$(cd "$(dirname "$0")" && pwd); h=${hash}
claude -p --model sonnet --strict-mcp-config --allowedTools ${TOOLS.map((x) => `"${x}"`).join(" ")} < "$d/$h.prompt.txt" > "$d/$h.md.tmp" 2> "$d/$h.log.tmp"
code=$?
if [ $code -eq 0 ] && [ -s "$d/$h.md.tmp" ]; then mv -f "$d/$h.md.tmp" "$d/$h.md"
else { echo "exit code $code"; cat "$d/$h.log.tmp"; } > "$d/$h.err"; fi
rm -f "$d/$h.md.tmp" "$d/$h.log.tmp"
`;

function toggle() {
  const t = theme(), node = find(layout(), PANEL), on = node && !node.hidden;
  return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-git").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => run("layout.toggle", { id: PANEL }))
      .child(svg("mods/git-graph/git-branch.svg").size(14).flex_none().text_color(on ? t.foreground : t.muted)).child("Git"));
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "toggle") return;
    this.commits = []; this.graph = []; this.selected = null; this.detail = null; this.files = []; this.open = null;
    this.rows = []; this.diffWidth = 0; this.scope = "all"; this.remotes = true; this.branch = ""; this.lanes = 1;
    this.tab = "diff"; this.ai = new Map(); this.running = new Map(); // ai: hash -> { text } | { error }; running: hash -> { started, address, reason }
    this.reap(cx);
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // A mod reload or app restart doesn't call close(), so the old instance's runs are still live: kill them and drop their partial files.
  // hc ls leaves labels out of its rows and --label needs a value, so a constant label finds the runs and hc get says which commit each explains.
  reap(cx) {
    cx.spawn(async () => {
      try {
        const live = JSON.parse((await exec("hc", ["ls", "--json", "--label", "git-graph.explain=1"])).stdout).terminals;
        await reapRuns(live, {
          kill: (address) => exec("hc", ["kill", address]),
          labels: async (address) => JSON.parse((await exec("hc", ["get", address, "--json"])).stdout).labels,
          removeTmp: (hash) => Promise.all([`${hash}.md.tmp`, `${hash}.log.tmp`].map((f) => fs.unlink(`${this.explainDir()}/${f}`).catch(() => {}))),
          warn: (...args) => console.log("git-graph:", ...args),
        });
      } catch (e) { console.log("git-graph: cannot reap earlier explain runs:", e); }
    });
  }

  async close(_cx) {
    await Promise.all([...(this.running?.values() ?? [])].map((r) => r.address && exec("hc", ["kill", r.address]).catch(() => {})));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(`${root}/.git`);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; } // shortcut: a worktree's .git is a file and can't be watched, the 10s timer covers it; upgrade by watching the path from git rev-parse --git-dir when the 10s lag in worktrees gets noticed
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.commits = []; this.graph = []; this.error = null; this.watched = null; this.select(null, cx);
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.commits = []; this.graph = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        // Without remotes, --branches --tags leaves out remote-tracking refs and their history.
        const scope = this.scope === "current" ? ["HEAD"] : this.remotes ? ["--all"] : ["--branches", "--tags"];
        const [log, head] = await Promise.all([
          git(["log", "--topo-order", "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e", "-n", String(MAX_COMMITS), ...scope]),
          git(["branch", "--show-current"]),
        ]);
        if (key() !== context) return;
        // An empty repo has no HEAD: git log fails, show no commits instead of an error.
        // shortcut: only "origin/" badges are hidden when Remotes is off, other remote names stay; upgrade if multi-remote repos matter.
        const commits = log.code !== 0 ? [] : log.stdout.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
          const [hash, parents, author, at, refs, subject] = r.split("\x1f");
          return { hash, parents: parents ? parents.split(" ") : [], author, at, subject,
            refs: refs ? refs.split(", ").map((x) => x.replace(/^HEAD -> /, "")).filter((x) => this.remotes || !x.startsWith("origin/")) : [] };
        });
        this.root = root; this.on = on; this.error = null; this.branch = head.stdout.trim() || "HEAD";
        this.commits = commits; this.graph = layoutGraph(commits);
        this.lanes = Math.min(8, Math.max(1, ...this.graph.map((g) => g.width))); // shortcut: graph column caps at 8 lanes, extra lanes are clipped; upgrade to a wider or horizontally scrollable graph column when a repo shows clipped lanes
        this.watch(root, cx);
        if (this.selected && !commits.some((c) => c.hash === this.selected)) this.select(null, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); if (this.again) { this.again = false; this.refresh(cx); } } // a filter change during a run was dropped; rerun with the new filter
    });
  }

  select(hash, cx) {
    this.selected = hash; this.detail = null; this.files = []; this.open = null; this.setLines([]);
    if (!hash) return;
    this.loadExplain(hash, cx);
    const root = this.root, on = this.on, context = this.context;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const commit = this.commits.find((c) => c.hash === hash), parent = commit?.parents[0];
        const [show, tree] = await Promise.all([
          git(["show", "-s", "--format=%H%x1f%P%x1f%an <%ae>%x1f%at%x1f%B", hash]),
          git(["diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", "-M", ...(parent ? [parent] : []), hash]),
        ]);
        if (show.code !== 0) throw new Error(show.stderr);
        if (this.selected !== hash || key() !== context) return;
        const [h, parents, author, at, ...message] = show.stdout.split("\x1f");
        this.detail = { hash: h, parents: parents.split(" ").filter(Boolean), author, date: stamp(at), message: message.join("\x1f").trim() };
        this.files = tree.code === 0 ? parseFiles(tree.stdout) : [];
        if (this.files.length) await this.pick(this.files[0], cx);
      } catch (e) { if (this.selected === hash) this.detail = { hash, parents: [], author: "", date: "", message: `Cannot read commit: ${e}` }; }
      cx.notify();
    });
    cx.notify();
  }

  explainDir() { return `${appHome()}/data/git-graph/explain`; }

  loadExplain(hash, cx) {
    if (this.on || this.ai.get(hash)?.text) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${this.explainDir()}/${hash}.md`).catch(() => null);
      if (text) { this.ai.set(hash, { text }); cx.notify(); }
    });
  }

  // shortcut: local repos only, upgrade by running hc run --on and readTextFile({on})
  // Runs carry the git-graph.explain=1 and git-graph.hash=<hash> labels so the next instance can reap them; a reaped run never fills this.ai.
  // shortcut: reap kills every labelled run, including one from another live git-graph copy; upgrade if git-graph is ever placed in more than one block
  explain(hash, cx) {
    const root = this.root;
    if (this.on || !root || this.running.has(hash)) return;
    const run = { started: Date.now() };
    this.running.set(hash, run); this.ai.delete(hash); cx.notify();
    const dir = this.explainDir(), windows = win()?.platform === "windows", ext = windows ? "ps1" : "sh";
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(dir, { recursive: true });
        for (const f of [`${hash}.err`, `${hash}.md`]) if (await fs.exists(`${dir}/${f}`)) await fs.unlink(`${dir}/${f}`);
        await fs.writeFile(`${dir}/${hash}.prompt.txt`, PROMPT(hash));
        await fs.writeFile(`${dir}/${hash}.${ext}`, windows ? POWERSHELL(hash) : POSIX(hash));
        const runner = windows ? ["pwsh", "-NoProfile", "-NonInteractive", "-File"] : ["sh"];
        const start = await exec("hc", ["run", "--json", "--bg", "--no-parent", "--label", "git-graph.explain=1", "--label", `git-graph.hash=${hash}`, "--cwd", root, "--", ...runner, `${dir}/${hash}.${ext}`]);
        if (start.code !== 0) throw new Error(start.stderr || start.stdout);
        const address = run.address = JSON.parse(start.stdout).address;
        if (run.reason) await this.stopRun(hash); // cancelled before the terminal existed
        // hc wait --json reports { ended: true } once the terminal has exited; each call stays under exec's 30 s limit.
        for (;;) {
          const left = EXPLAIN_TIMEOUT_MS - (Date.now() - run.started);
          if (left <= 0 && !run.reason) { run.timedOut = true; await this.stopRun(hash, "逾時：Claude 超過 3 分鐘沒有完成，已自動結束"); }
          const w = await exec("hc", ["wait", address, "--timeout", String(Math.max(1, Math.min(20, Math.ceil(left / 1000)))), "--json"]);
          if (w.code !== 0 || JSON.parse(w.stdout).ended) break;
        }
        const md = await readTextFile(`${dir}/${hash}.md`).catch(() => null);
        const err = md || run.reason ? null : await readTextFile(`${dir}/${hash}.err`).catch(() => null);
        const { cleanup, ...shown } = explainOutcome({ reason: run.reason, timedOut: run.timedOut, md, err });
        if (cleanup) for (const f of [`${hash}.md`, `${hash}.md.tmp`, `${hash}.log.tmp`]) await fs.unlink(`${dir}/${f}`).catch(() => {});
        this.ai.set(hash, shown);
      } catch (e) { this.ai.set(hash, { error: String(e?.message ?? e) }); }
      finally { this.running.delete(hash); cx.notify(); }
    });
  }

  // Ends the run's core terminal; explain() sees run.reason and, unless a timeout lost the race to a finished result, shows it as the error and removes the partial files.
  async stopRun(hash, reason) {
    const run = this.running.get(hash);
    if (!run) return;
    run.reason ||= reason;
    if (run.address) await exec("hc", ["kill", run.address]).catch(() => {});
  }

  aiPanel(t) {
    const hash = this.selected, a = this.ai.get(hash);
    const note = (...kids) => v_flex().flex_1().min_h(0).p(12).gap(10).items_start().children(kids);
    const button = (id, label) => div().id(id).h(26).px(12).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground)
      .cursor_pointer().on_mouse_down("left", stop).on_click((_e, cx) => this.explain(hash, cx)).child(label);
    if (this.on) return note(div().text_color(t.muted).child("AI 解釋目前只支援本機 repo"));
    if (this.running.has(hash)) return note(h_flex().gap(8).items_center().text_color(t.muted)
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).spin(900)).child("Claude 正在讀這個 commit…")
      .child(div().id("git-ai-cancel").h(22).px(10).flex().items_center().rounded(5).text_size(12).bg(t.raised).text_color(t.foreground)
        .cursor_pointer().on_mouse_down("left", stop).on_click(() => this.stopRun(hash, "已取消")).child("取消")));
    if (a?.text) return div().id("git-ai").flex_1().min_h(0).overflow_y_scrollbar().p(12).child(TextView.markdown(`git-ai-${hash}`, a.text));
    if (a?.error) return note(div().text_color(t.ansi1).child(a.error), button("git-ai-retry", "重試"));
    return note(div().text_color(t.muted).child("用 Claude 讀這個 commit 的內容並以正體中文解釋。會執行 claude，消耗你的 Claude 額度，結果存檔，下次直接顯示。"),
      button("git-ai-run", "用 Claude 解釋"));
  }

  async pick(file, cx) {
    const hash = this.selected, root = this.root, on = this.on;
    this.open = file.path; this.setLines([]); cx.notify();
    const parent = this.commits.find((c) => c.hash === hash)?.parents[0];
    const args = diffArgs(parent, hash, file);
    let lines;
    try {
      const r = await exec("git", [...READ, ...args], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? ["No text diff available (binary or empty)"] : all.slice(first);
    } catch { lines = ["Cannot preview this diff (too large or unreadable)"]; }
    if (this.selected === hash && this.open === file.path) this.setLines(lines.slice(0, 1500).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
    cx.notify();
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 50));
  }

  gw() { return Math.max(44, this.lanes * LANE + 6); }

  setFilter(patch, cx) { Object.assign(this, patch); this.again ||= this.loading; this.refresh(cx); }

  // Each lane segment is a native stroked path; coordinates are relative to the cell.
  graphCell(g, t, selected) {
    const color = (i) => t[`ansi${[2, 3, 4, 5, 6, 9, 10, 12][i % 8]}`];
    const x = (lane) => lane * LANE + LANE / 2, w = this.gw();
    const cell = div().relative().w(w).h(ROW).flex_none().overflow_hidden();
    for (const l of g.lines) {
      const y0 = l.half * ROW / 2, y1 = y0 + ROW / 2;
      cell.child(window.paint_path(PathBuilder.stroke(2).move_to(x(l.a), y0).line_to(x(l.b), y1).build(), color(l.color)));
    }
    return cell.child(div().absolute().left(x(g.lane) - 5).top(ROW / 2 - 5).w(10).h(10).rounded_full().bg(color(g.color)).border_2().border_color(selected ? t.selected : t.background));
  }

  badge(ref, t) {
    const tag = ref.startsWith("tag: "), remote = ref.startsWith("origin/");
    return div().h(16).px(5).flex_none().flex().items_center().rounded(4).border_1().text_size(10)
      .border_color(tag ? t.ansi3 : remote ? t.ansi5 : t.ansi2).text_color(tag ? t.ansi3 : remote ? t.ansi5 : t.ansi2).child(ref.replace(/^tag: /, ""));
  }

  commitRow(i, t) {
    const c = this.commits[i], on = c.hash === this.selected;
    return h_flex().id(`c-${c.hash}`).w_full().h(ROW).flex_none().px(10).gap(8).items_center().cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(this.graphCell(this.graph[i], t, on))
      .child(div().w(60).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted).child(c.hash.slice(0, 7)))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden()
        .children(c.refs.map((r) => this.badge(r, t))).child(div().min_w(0).truncate().child(c.subject)))
      .child(div().w(100).flex_none().truncate().text_color(t.muted).child(c.author))
      .child(div().w(124).flex_none().whitespace_nowrap().text_color(t.muted).child(stamp(c.at)));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    // A ~9% tint vanished on dark themes: a stronger tint plus a colored sign and line number mark changed lines.
    const color = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : null;
    return h_flex().w_full().h(20).flex_none().gap(6).when(Boolean(color), (e) => e.bg(color + "33"))
      .child(div().w(30).flex_none().text_right().text_color(color ?? t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(color ?? t.dim).child(color ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  detailPanel(t) {
    const d = this.detail, kv = (k, v) => h_flex().gap(8).child(div().w(54).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).child(v));
    const color = (s) => s === "A" ? t.ansi2 : s === "D" ? t.ansi1 : s === "M" ? t.blocked : t.ansi4;
    return h_flex().size_full().border_t(1).border_color(t.border)
      .child(v_flex().w(320).h_full().flex_none().overflow_hidden().p(12).gap(8).border_r(1).border_color(t.border)
        .child(div().id("git-msg").flex_none().max_h(48).overflow_y_scrollbar().font_semibold().child(d?.message ?? "Loading…"))
        .when(Boolean(d), (e) => e.child(v_flex().flex_none().gap(2).text_size(12)
          .child(kv("Commit", d.hash.slice(0, 10))).child(kv("Parents", d.parents.map((p) => p.slice(0, 7)).join(" ") || "none"))
          .child(kv("Author", d.author)).child(kv("Date", d.date))))
        .child(div().flex_none().text_size(12).font_semibold().text_color(t.muted).child(`變更檔案 (${this.files.length})`))
        .child(v_flex().id("git-files").flex_1().min_h(0).overflow_y_scrollbar().children(this.files.map((f) =>
          h_flex().id(`f-${f.path}`).h(24).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer()
            .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.spawn(async (cx) => this.pick(f, cx)))
            .child(div().w(12).text_size(11).text_color(color(f.status)).child(f.status))
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(f.path))))))
      .child(v_flex().flex_1().min_w(0).h_full().overflow_hidden()
        .child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(h_flex().p(2).gap(2).rounded(7).bg(t.chrome).border_1().border_color(t.border)
            .child(segButton(t, "git-tab-diff", "Diff", this.tab === "diff", (cx) => { this.tab = "diff"; cx.notify(); }))
            .child(segButton(t, "git-tab-ai", "AI 解釋", this.tab === "ai", (cx) => { this.tab = "ai"; cx.notify(); })))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.tab === "diff" ? this.open ?? "" : "")))
        .child(this.tab === "ai" ? this.aiPanel(t) : div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
          .child(div().id("git-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("git-diff", this.rows.length, 20, (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("git-diff").viewport_from_layout().absolute().inset_0())));
  }

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), seg = (...a) => segButton(t, ...a);
    return v_flex().id("git-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center()
        .child(div().font_semibold().child("Graph"))
        .when(Boolean(this.root), (e) => e.child(div().px(8).py(1).rounded(10).bg(t.selected).text_size(11).text_color(t.muted).child(this.branch)))
        .child(div().flex_1())
        .child(div().id("git-refresh").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click((_e, cx) => this.refresh(cx)).child(svg("mods/git-graph/refresh.svg").size(14).text_color(t.muted))))
      .child(h_flex().h(34).flex_none().px(14).gap(12).items_center()
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.chrome).border_1().border_color(t.border)
          .child(seg("git-all", "All branches", this.scope === "all", (cx) => this.setFilter({ scope: "all" }, cx)))
          .child(seg("git-cur", "Current", this.scope === "current", (cx) => this.setFilter({ scope: "current" }, cx))))
        .child(h_flex().id("git-remotes").gap(6).items_center().cursor_pointer().text_size(12).on_mouse_down("left", stop)
          .on_click((_e, cx) => this.setFilter({ remotes: !this.remotes }, cx))
          .child(div().size(14).flex().items_center().justify_center().rounded(3).border_1().border_color(this.remotes ? t.accent : t.input).bg(this.remotes ? t.accent : t.background)
            .text_size(10).text_color(t.accent_foreground).child(this.remotes ? "✓" : ""))
          .child("Remotes")))
      .child(h_flex().h(24).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().w(this.gw()).flex_none().child("Graph")).child(div().w(60).flex_none().child("Commit"))
        .child(div().flex_1().child("Description")).child(div().w(100).flex_none().child("Author")).child(div().w(124).flex_none().child("Date")))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("git-log", this.commits.length, ROW, (i) => this.commits[i].hash,
          (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(this.commitRow(i, t)); return out; })
          .on_item_click((hash, cx) => this.select(hash === this.selected ? null : hash, cx)).size_full())
        .child(Scrollbar.vertical("git-log").viewport_from_layout().absolute().inset_0())
        .when(!this.commits.length, (e) => e.child(div().absolute().top(8).px(14).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : this.root ? "No commits yet" : "No folder")))))
      .when(Boolean(this.selected), (e) => e.child(div().relative().h(DETAIL).flex_none()
        .child(this.detailPanel(t))
        .child(div().id("git-close").absolute().top(5).right(8).size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.select(null, cx)).child("×"))));
  }
}
