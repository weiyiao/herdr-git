// Pure helpers for a commit's file list and the git command that previews one file.

// `git diff-tree -z --name-status`: "M\0path\0", renames and copies "R100\0old\0new\0".
export function parseFiles(out) {
  const tok = out.split("\0"), files = [];
  for (let i = 0; i < tok.length - 1;) {
    const status = tok[i][0], two = status === "R" || status === "C";
    files.push(two ? { status, from: tok[i + 1], path: tok[i + 2] } : { status, path: tok[i + 1] });
    i += two ? 3 : 2;
  }
  return files;
}

// Argv for one file's diff; a root commit has no parent to diff against.
export function diffArgs(parent, hash, file) {
  const base = ["--no-ext-diff", "--no-textconv", "--no-color"];
  // The old path must be in the pathspec, or git shows a renamed file as a whole-file add.
  const paths = file.from ? [file.from, file.path] : [file.path];
  return parent ? ["diff", ...(file.from ? ["-M"] : []), ...base, parent, hash, "--", ...paths] : ["show", "--format=", ...base, hash, "--", file.path];
}
