import os from "node:os";

export interface SystemUsageSnapshot {
	cpuPercent?: number;
	memPercent?: number;
}

export function getMemoryPercentUsed(): number {
	const total = os.totalmem();
	if (total <= 0) return 0;
	const free = os.freemem();
	const used = total - free;
	const percent = (used / total) * 100;
	return clampPercent(percent);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function sumCpuTimes(cpus: os.CpuInfo[]): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

export interface CpuSampler {
	sample(): number | undefined;
}

/** CPU utilization from deltas between consecutive `sample()` calls. First sample returns undefined. */
export function createCpuSampler(): CpuSampler {
	let previous: { idle: number; total: number } | undefined;

	return {
		sample(): number | undefined {
			const cpus = os.cpus();
			const current = sumCpuTimes(cpus);
			if (previous === undefined) {
				previous = current;
				return undefined;
			}

			const idleDelta = current.idle - previous.idle;
			const totalDelta = current.total - previous.total;
			previous = current;

			if (totalDelta <= 0) return undefined;
			const busy = totalDelta - idleDelta;
			const percent = (busy / totalDelta) * 100;
			return clampPercent(percent);
		},
	};
}

type ThemeFg = (color: "success" | "warning" | "error" | "dim", text: string) => string;

export function getUsageLevelColor(percent: number | undefined): "success" | "warning" | "error" | "dim" {
	if (percent === undefined) return "dim";
	if (percent >= 95) return "error";
	if (percent >= 85) return "warning";
	return "success";
}

function formatPercentPart(
	theme: { fg: ThemeFg },
	label: "CPU" | "MEM",
	percent: number | undefined,
): string | undefined {
	if (percent === undefined) return undefined;
	const rounded = Math.round(percent);
	return theme.fg(getUsageLevelColor(percent), `${label} ${rounded}%`);
}

export function formatSystemSection(
	theme: { fg: ThemeFg },
	usage: SystemUsageSnapshot,
): string {
	const cpu = formatPercentPart(theme, "CPU", usage.cpuPercent);
	const mem = formatPercentPart(theme, "MEM", usage.memPercent);
	const parts = [cpu, mem].filter((p): p is string => p !== undefined);
	return parts.join(" · ");
}

export function refreshSystemUsage(sampler: CpuSampler): SystemUsageSnapshot {
	return {
		cpuPercent: sampler.sample(),
		memPercent: getMemoryPercentUsed(),
	};
}