export type GrokProductUsage = {
	product?: string;
	usage_percent?: unknown;
};

export type GrokUsagePayload = {
	ok?: boolean;
	error?: string;
	fetched_at?: string | null;
	subscription_tier?: string | null;
	credit_usage_percent?: unknown;
	product_usage?: GrokProductUsage[] | null;
	period?: {
		type?: string | null;
		start?: string | null;
		end?: string | null;
	} | null;
};

export const USAGE_FIELD_NAMES: Record<string, string> = {
	fetched_at: "Fetched at",
	subscription_tier: "Subscription tier",
	credit_usage_percent: "Credit usage",
	product_usage: "Allowances",
	period: "Period",
};

export function usageFieldName(attribute: string): string {
	return USAGE_FIELD_NAMES[attribute] ?? attribute;
}

export function productDisplayName(product: string): string {
	return product.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function parseUsagePayload(raw: string): GrokUsagePayload | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as GrokUsagePayload) : null;
	} catch {
		return null;
	}
}

export function formatUsagePercent(value: unknown): string {
	const percent = Number(value);
	if (!Number.isFinite(percent)) return "unknown";
	return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

export function usageBar(value: unknown, width = 18): string {
	const percent = Number(value);
	if (!Number.isFinite(percent)) return "░".repeat(width);
	const clamped = Math.min(100, Math.max(0, percent));
	const filled = Math.round((clamped / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatRelativeTime(date: Date, now = new Date()): string {
	const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
	const abs = Math.abs(seconds);
	if (abs < 45) return "just now";

	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	const [unit, unitSeconds] = units.find(([, unitSeconds]) => abs >= unitSeconds) ?? ["second", 1];
	return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / unitSeconds), unit);
}

function formatDateTime(value: string | null | undefined): string {
	const date = parseDate(value);
	if (!date) return value || "unknown";
	const absolute = new Intl.DateTimeFormat(undefined, {
		day: "2-digit",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
	return `${absolute} (${formatRelativeTime(date)})`;
}

function formatShortDate(value: string | null | undefined): string | null {
	const date = parseDate(value);
	if (!date) return value || null;
	return new Intl.DateTimeFormat(undefined, {
		day: "2-digit",
		month: "short",
		year: "numeric",
	}).format(date);
}

function formatPeriod(period: GrokUsagePayload["period"]): string[] {
	if (!period || typeof period !== "object") return ["unknown"];
	const lines = [period.type || "unknown"];
	const start = formatShortDate(period.start);
	const end = formatShortDate(period.end);
	if (start && end) {
		lines.push(`${start} → ${end}`);
	} else if (start || end) {
		lines.push(start ?? end ?? "unknown");
	}

	const endDate = parseDate(period.end);
	if (endDate) {
		const isFuture = endDate.getTime() >= Date.now();
		lines.push(`${isFuture ? "resets" : "ended"} ${formatRelativeTime(endDate)}`);
	}
	return lines;
}

function numericPercent(value: unknown): number | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	const percent = Number(value);
	return Number.isFinite(percent) ? percent : undefined;
}

function productUsageRows(products: GrokProductUsage[] | null | undefined): [string, string][] {
	if (!Array.isArray(products) || products.length === 0) return [];
	const rows: [string, string][] = [];
	for (const item of products) {
		const product = typeof item?.product === "string" ? item.product.trim() : "";
		if (!product) continue;
		const percent = numericPercent(item.usage_percent);
		const value = percent === undefined ? "—" : `${usageBar(percent)} ${formatUsagePercent(percent)}`;
		rows.push([productDisplayName(product), value]);
	}
	return rows;
}

function creditAndProductRows(payload: GrokUsagePayload): [string, string][] {
	const productRows = productUsageRows(payload.product_usage);
	const creditPercent = numericPercent(payload.credit_usage_percent);
	const creditRow: [string, string] = [
		usageFieldName("credit_usage_percent"),
		`${usageBar(payload.credit_usage_percent)} ${formatUsagePercent(payload.credit_usage_percent)}`,
	];

	if (productRows.length === 0) return [creditRow];

	const measured = (payload.product_usage ?? [])
		.map((item) => numericPercent(item.usage_percent))
		.filter((percent): percent is number => percent !== undefined);
	const bankMatchesOverall =
		measured.length > 0 &&
		creditPercent !== undefined &&
		measured.every((percent) => percent === creditPercent);

	// Unified SuperGrok reports the same weekly pool as creditUsagePercent and GrokBuild.
	return bankMatchesOverall ? productRows : [creditRow, ...productRows];
}

export function formatUsageCard(raw: string): string {
	const payload = parseUsagePayload(raw);
	if (!payload) return raw;

	if (payload.ok === false) {
		return [`╭─ Grok usage ─╮`, `│ unavailable  │`, `│ ${payload.error ?? "unknown error"}`, `╰──────────────╯`].join("\n");
	}

	const rows: [string, string][] = [
		[usageFieldName("fetched_at"), formatDateTime(payload.fetched_at)],
		[usageFieldName("subscription_tier"), payload.subscription_tier ?? "Unknown"],
		...creditAndProductRows(payload),
	];
	const periodLines = formatPeriod(payload.period);
	rows.push([usageFieldName("period"), periodLines[0] ?? "unknown"]);
	for (const line of periodLines.slice(1)) {
		rows.push(["", line]);
	}

	const labelWidth = Math.max(...rows.map(([label]) => label.length));
	const contentWidth = Math.max(
		" Grok usage ".length,
		...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`.length),
	);
	const title = " Grok usage ";
	const top = `╭─${title}${"─".repeat(Math.max(0, contentWidth - title.length))}─╮`;
	const bottom = `╰${"─".repeat(contentWidth + 2)}╯`;
	const body = rows.map(([label, value]) => {
		const line = `${label.padEnd(labelWidth)}  ${value}`;
		return `│ ${line.padEnd(contentWidth)} │`;
	});

	return [top, ...body, bottom].join("\n");
}
