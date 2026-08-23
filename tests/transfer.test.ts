import { expect, test } from "bun:test";
import { fromJson, fromMarkdown, toJson, toMarkdown, type ObsIn } from "../src/ui/transfer";

const items: ObsIn[] = [
  { type: "decision", title: "Use UV", narrative: "We use uv.\n\nNever pip.", facts: ["uv add", "uv run"], files: ["pyproject.toml"], pinned: true },
  { type: "other", title: "Plain", narrative: "Just text", facts: [], files: [], pinned: false },
];

test("markdown round-trips", () => {
  const md = toMarkdown(items);
  expect(md).toContain("## [decision] Use UV");
  expect(md).toContain("- uv add");
  expect(md).toContain("files: pyproject.toml");
  expect(md).toContain("pinned: yes");
  expect(fromMarkdown(md)).toEqual(items);
});

test("markdown tolerates missing type and garbage", () => {
  expect(fromMarkdown("## Untyped\n\nbody\n")).toEqual([{ type: "other", title: "Untyped", narrative: "body", facts: [], files: [], pinned: false }]);
  expect(fromMarkdown("no headings here")).toEqual([]);
  expect(fromMarkdown("")).toEqual([]);
});

test("json round-trips and rejects non-arrays", () => {
  expect(fromJson(toJson(items))).toEqual(items);
  expect(fromJson("{}")).toEqual([]);
  expect(fromJson("not json")).toEqual([]);
  expect(fromJson('[{"title":"t"}]')).toEqual([{ type: "other", title: "t", narrative: "", facts: [], files: [], pinned: false }]);
});
