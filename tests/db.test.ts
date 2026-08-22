import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { acquireLock, claimNextJob, enqueue, finishJob, releaseLock } from "../src/db";
import { normalizeRemote } from "../src/project";

process.env.RECALL_DIR = "/tmp/recall-test-" + process.pid;
const { openDb } = await import("../src/db");

test("jobs claim atomically and dedupe", () => {
  const db = openDb();
  enqueue(db, "observe", 1);
  enqueue(db, "observe", 1);
  enqueue(db, "observe", 2);
  const a = claimNextJob(db)!;
  const b = claimNextJob(db)!;
  expect(a.ref_id).toBe(1);
  expect(b.ref_id).toBe(2);
  expect(claimNextJob(db)).toBeNull();
  finishJob(db, a.id, false, "boom");
  const again = claimNextJob(db)!;
  expect(again.id).toBe(a.id);
  expect(again.attempts).toBe(2);
});

test("lock is exclusive until released or expired", () => {
  const db = openDb();
  expect(acquireLock(db, "t", "A", 60000)).toBe(true);
  expect(acquireLock(db, "t", "B", 60000)).toBe(false);
  expect(acquireLock(db, "t", "A", 60000)).toBe(true);
  releaseLock(db, "t", "A");
  expect(acquireLock(db, "t", "B", 60000)).toBe(true);
  expect(acquireLock(db, "t", "C", 60000)).toBe(false);
});

test("remote normalization", () => {
  const a = normalizeRemote("git@github.com:Acme/API.git");
  const b = normalizeRemote("https://github.com/acme/api");
  const c = normalizeRemote("ssh://git@github.com/acme/api.git");
  expect(a).toBe(b);
  expect(b).toBe(c);
});
