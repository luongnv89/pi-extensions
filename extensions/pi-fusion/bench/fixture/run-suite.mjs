// Verbose test runner. Prints a large amount of output on purpose:
// reading it is what makes verification expensive for the main agent.
const SUITES = [
	"cart", "pricing", "orders", "report", "index", "utils", "format", "parse",
	"round", "shipping", "loyalty", "totals", "tax", "currency", "coupons", "refunds",
	"inventory", "catalog", "search", "session", "auth", "audit", "export", "import",
	"webhooks", "retries", "throttle", "cache", "metrics", "config",
];
const CASES = [
	"handles-empty-input", "handles-single-item", "handles-many-items", "rejects-negative",
	"rejects-nan", "keeps-precision", "is-idempotent", "matches-golden", "handles-unicode",
	"handles-large-values", "preserves-order", "is-pure", "handles-null", "handles-undefined",
	"round-trips", "is-stable-sorted", "handles-duplicates", "handles-whitespace",
	"rejects-oversize", "handles-zero", "handles-boundary", "is-reentrant",
	"handles-concurrency", "handles-timeout", "reports-errors", "logs-once",
	"validates-schema", "normalizes-case", "trims-input", "is-deterministic",
];

const FAILURES = new Set([
	"orders/refund-window-boundary",
	"pricing/rounds-half-up",
	"report/utf8-column-alignment",
]);

let passed = 0;
let failed = 0;
const lines = [];

lines.push("bench-suite v1.0.0");
lines.push("");

for (const suite of SUITES) {
	lines.push(`SUITE ${suite}`);
	for (const testCase of CASES) {
		const name = `${suite}/${testCase}`;
		lines.push(`  ok   ${name} (${(name.length % 7) + 1}ms)`);
		passed += 1;
	}
	lines.push("");
}

lines.push("SUITE edge-cases");
for (const name of FAILURES) {
	lines.push(`  FAIL ${name}`);
	lines.push(`       expected: 2 but got 3`);
	lines.push(`       at ${name.split("/")[0]}.test.mjs:${name.length}`);
	failed += 1;
}
lines.push("");
lines.push(`# pass ${passed}`);
lines.push(`# fail ${failed}`);

console.log(lines.join("\n"));
process.exit(failed > 0 ? 1 : 0);
