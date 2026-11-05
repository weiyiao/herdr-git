import assert from "node:assert/strict";
import { parseFiles, diffArgs } from "./parse.js";

// rename keeps the old path as from
assert.deepEqual(parseFiles("R100\0old.txt\0new.txt\0M\0a.js\0"), [
  { status: "R", from: "old.txt", path: "new.txt" },
  { status: "M", path: "a.js" },
]);
// copy is treated like a rename
assert.deepEqual(parseFiles("C075\0src.js\0dup.js\0"), [{ status: "C", from: "src.js", path: "dup.js" }]);
// plain A/M/D
assert.deepEqual(parseFiles("A\0a\0M\0b\0D\0c\0"), [{ status: "A", path: "a" }, { status: "M", path: "b" }, { status: "D", path: "c" }]);
// empty output
assert.deepEqual(parseFiles(""), []);

const base = ["--no-ext-diff", "--no-textconv", "--no-color"];
// rename: -M and both paths in the pathspec
assert.deepEqual(diffArgs("p", "h", { status: "R", from: "old", path: "new" }), ["diff", "-M", ...base, "p", "h", "--", "old", "new"]);
// normal file
assert.deepEqual(diffArgs("p", "h", { status: "M", path: "a" }), ["diff", ...base, "p", "h", "--", "a"]);
// root commit
assert.deepEqual(diffArgs(undefined, "h", { status: "A", path: "a" }), ["show", "--format=", ...base, "h", "--", "a"]);

console.log("parse.test ok");
