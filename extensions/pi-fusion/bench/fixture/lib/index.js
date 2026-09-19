import { buildOrder } from "./orders.js";
import { oldLog } from "./old-logger.js";
import { formatSummary, summarize } from "./report.js";

export const SAMPLE_ORDERS = [
	["A-100", [{ price: 12.5, quantity: 2 }, { price: 3, quantity: 4 }]],
	["A-101", [{ price: 99.99, quantity: 1 }]],
	["A-102", [{ price: 7.25, quantity: 3 }, { price: 15, quantity: 1 }]],
];

export function runPipeline() {
	oldLog("index", "running pipeline");
	const orders = SAMPLE_ORDERS.map(([id, items]) => buildOrder(id, items));
	return { orders, summary: summarize(orders) };
}

export { formatSummary };
