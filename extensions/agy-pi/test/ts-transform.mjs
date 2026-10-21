import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src") + sep;

export async function load(url, context, next) {
  if (!url.startsWith(`file://${srcRoot}`) || !url.endsWith(".ts")) {
    return next(url, context);
  }
  const source = readFileSync(fileURLToPath(url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  return { format: "module", shortCircuit: true, source: outputText };
}
