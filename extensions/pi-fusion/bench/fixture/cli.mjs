import { formatSummary, runPipeline } from "./lib/index.js";

console.log("Loading orders...");
const { orders, summary } = runPipeline();
console.log(`Processed ${orders.length} orders.`);
console.log(formatSummary(summary));
