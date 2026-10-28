import { describe, expect, it } from "vitest";
import { planModeBuiltin } from "../src/extensions/plan-mode/index.ts";

describe("built-in extensions", () => {
	it("loads Plan Mode by default", () => {
		expect(planModeBuiltin).toMatchObject({ name: "plan-mode", builtin: true });
	});
});
