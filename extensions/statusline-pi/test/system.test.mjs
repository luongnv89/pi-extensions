import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
	createCpuSampler,
	formatSystemSection,
	getMemoryPercentUsed,
	getUsageLevelColor,
} from "../dist/system.js";

const theme = {
	fg: (color, text) => `${color}:${text}`,
};

describe("system usage formatting", () => {
	it("colors usage by threshold like speed/cost patterns", () => {
		assert.equal(getUsageLevelColor(50), "success");
		assert.equal(getUsageLevelColor(84), "success");
		assert.equal(getUsageLevelColor(85), "warning");
		assert.equal(getUsageLevelColor(94), "warning");
		assert.equal(getUsageLevelColor(95), "error");
		assert.equal(getUsageLevelColor(undefined), "dim");
	});

	it("omits CPU on first sample and includes MEM", () => {
		const out = formatSystemSection(theme, { cpuPercent: undefined, memPercent: 68 });
		assert.equal(out, "success:MEM 68%");
	});

	it("joins CPU and MEM with middle dot", () => {
		const out = formatSystemSection(theme, { cpuPercent: 42.4, memPercent: 68.1 });
		assert.equal(out, "success:CPU 42% · success:MEM 68%");
	});

	it("returns empty string when both parts undefined", () => {
		assert.equal(formatSystemSection(theme, {}), "");
	});
});

describe("memory percent", () => {
	it("clamps to 0-100 from os mem", () => {
		const totalmem = mock.method(os, "totalmem", () => 1000);
		const freemem = mock.method(os, "freemem", () => 320);
		try {
			assert.equal(getMemoryPercentUsed(), 68);
		} finally {
			totalmem.mock.restore();
			freemem.mock.restore();
		}
	});

	it("returns 0 when total mem is zero", () => {
		const totalmem = mock.method(os, "totalmem", () => 0);
		const freemem = mock.method(os, "freemem", () => 0);
		try {
			assert.equal(getMemoryPercentUsed(), 0);
		} finally {
			totalmem.mock.restore();
			freemem.mock.restore();
		}
	});
});

describe("CPU sampler", () => {
	it("computes percent from cpu time deltas", () => {
		let call = 0;
		const cpusMock = mock.method(os, "cpus", () => {
			call += 1;
			if (call === 1) {
				return [
					{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
					{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
				];
			}
			return [
				{ times: { user: 150, nice: 0, sys: 60, idle: 890, irq: 0 } },
				{ times: { user: 150, nice: 0, sys: 60, idle: 890, irq: 0 } },
			];
		});

		try {
			const sampler = createCpuSampler();
			assert.equal(sampler.sample(), undefined);
			const pct = sampler.sample();
			// two identical CPUs: idle +80, total +200 => busy 120 => 60%
			assert.ok(Math.abs(pct - 60) < 0.01, `expected ~60%, got ${pct}`);
		} finally {
			cpusMock.mock.restore();
		}
	});
});