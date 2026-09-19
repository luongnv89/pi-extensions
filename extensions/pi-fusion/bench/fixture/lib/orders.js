import { cartSubtotal } from "./cart.js";
import { oldLog, oldLogTimer } from "./old-logger.js";
import { computeDiscountedTotal, withShipping } from "./pricing.js";

export function buildOrder(id, items) {
	const done = oldLogTimer("orders");
	oldLog("orders", `building order ${id}`);
	const subtotal = cartSubtotal(items);
	const discounted = computeDiscountedTotal(subtotal);
	done();
	return { id, subtotal, discounted, total: withShipping(discounted) };
}
