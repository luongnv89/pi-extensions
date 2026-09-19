import { oldLog } from "./old-logger.js";
import { round2 } from "./pricing.js";

export function cartSubtotal(items) {
	oldLog("cart", `summing ${items.length} items`);
	return round2(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

export function itemCount(items) {
	oldLog("cart", "counting items");
	return items.reduce((sum, item) => sum + item.quantity, 0);
}
