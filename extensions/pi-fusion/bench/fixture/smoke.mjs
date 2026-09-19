// Behaviour guard: the numbers must survive any refactor of this project.
import assert from "node:assert/strict";
import { runPipeline, formatSummary } from "./lib/index.js";

const { orders, summary } = runPipeline();
assert.equal(orders.length, 3, "expected three orders");
assert.equal(orders[0].id, "A-100");
assert.equal(orders[0].subtotal, 37);
assert.equal(orders[0].discounted, 32.19);
assert.equal(orders[0].total, 36.69);
assert.equal(summary.orders, 3);
assert.equal(typeof formatSummary(summary), "string");
console.log("SMOKE OK");
