import assert from "node:assert/strict";
import { test } from "node:test";
import { subtract } from "../generic-actions/google-service-ranges/ranges.mjs";

test("subtract keeps a range nothing excludes, and drops one an exclusion covers", () => {
  assert.deepEqual(subtract(["8.8.4.0/24"], ["10.0.0.0/8"]), ["8.8.4.0/24"]);
  assert.deepEqual(subtract(["34.76.0.0/16"], ["34.64.0.0/10"]), []);
});

test("subtract splits a range around a hole into the fewest aligned blocks", () => {
  assert.deepEqual(subtract(["10.0.0.0/24"], ["10.0.0.64/26"]), ["10.0.0.0/26", "10.0.0.128/25"]);
  assert.deepEqual(subtract(["10.0.0.0/30"], ["10.0.0.1/32"]), ["10.0.0.0/32", "10.0.0.2/31"]);
});

test("subtract joins overlapping and adjacent inputs, and sorts the result", () => {
  assert.deepEqual(subtract(["10.0.1.0/24", "10.0.0.0/24", "10.0.0.128/25"], []), ["10.0.0.0/23"]);
});

test("subtract applies one exclusion to every range it spans", () => {
  assert.deepEqual(subtract(["10.0.0.0/26", "10.0.0.128/26"], ["10.0.0.32/27", "10.0.0.64/26", "10.0.0.128/27"]), [
    "10.0.0.0/27",
    "10.0.0.160/27",
  ]);
});

test("subtract handles addresses at and above 2^31", () => {
  assert.deepEqual(subtract(["128.0.0.0/1"], ["192.0.0.0/2"]), ["128.0.0.0/2"]);
  assert.deepEqual(subtract(["255.255.255.254/31"], ["255.255.255.254/32"]), ["255.255.255.255/32"]);
});
