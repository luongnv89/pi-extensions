// Deprecated logging shim. Scheduled for removal.
const PREFIX = "[legacy]";

export function oldLog(scope, message) {
	if (process.env.BENCH_QUIET === "1") return;
	process.stderr.write(`${PREFIX} ${scope}: ${message}\n`);
}

export function oldLogTimer(scope) {
	const startedAt = Date.now();
	return () => oldLog(scope, `took ${Date.now() - startedAt}ms`);
}
