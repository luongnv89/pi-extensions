const LOYALTY_DISCOUNT_MULTIPLIER = 0.87;
const SHIPPING_FLAT = 4.5;

export function computeDiscountedTotal(subtotal) {
	return round2(subtotal * LOYALTY_DISCOUNT_MULTIPLIER);
}

export function withShipping(total) {
	return round2(total + SHIPPING_FLAT);
}

export function round2(value) {
	return Math.round(value * 100) / 100;
}
