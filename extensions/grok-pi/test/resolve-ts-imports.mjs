export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith(".") && specifier.endsWith(".js")) {
		try {
			return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		} catch {
			// Keep Node's normal error for JavaScript imports without a TypeScript sibling.
		}
	}
	return nextResolve(specifier, context);
}
