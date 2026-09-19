import { oldLog } from "./old-logger.js";
import { round2 } from "./pricing.js";

export function summarize(orders) {
	oldLog("report", `summarizing ${orders.length} orders`);
	return {
		orders: orders.length,
		subtotal: round2(orders.reduce((sum, order) => sum + order.subtotal, 0)),
		total: round2(orders.reduce((sum, order) => sum + order.total, 0)),
	};
}

export function formatSummary(summary) {
	return [
		`orders   ${summary.orders}`,
		`subtotal ${summary.subtotal.toFixed(2)}`,
		`total    ${summary.total.toFixed(2)}`,
	].join("\n");
}
