import { expect, test } from "bun:test";
import { pathIsSensitive, redact, stripPrivate } from "../src/redact";
import { DEFAULTS } from "../src/settings";

test("redacts common secrets", () => {
  const s = redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and ghp_abcdefghijklmnopqrstuvwxyz012345 and postgres://u:p4ssw0rd@host/db and AKIAABCDEFGHIJKLMNOP");
  expect(s).not.toContain("sk-ant-api03");
  expect(s).not.toContain("ghp_abc");
  expect(s).toContain("postgres://u:[REDACTED]@host/db");
  expect(s).not.toContain("AKIAABCDEFGHIJKLMNOP");
});

test("redacts key=value assignments", () => {
  expect(redact("API_KEY=supersecretvalue123")).toBe("API_KEY=[REDACTED]");
  expect(redact('password: "hunter2hunter2"')).toContain("[REDACTED]");
});

test("private tags stripped", () => {
  expect(stripPrivate("a <private>hidden</private> b")).toBe("a [private] b");
});

test("sensitive paths", () => {
  expect(pathIsSensitive("/repo/.env", DEFAULTS.excludePathPatterns)).toBe(true);
  expect(pathIsSensitive("C:\\repo\\.env.local", DEFAULTS.excludePathPatterns)).toBe(true);
  expect(pathIsSensitive("/repo/src/app.ts", DEFAULTS.excludePathPatterns)).toBe(false);
});
