export type CheckStatus = "pass" | "fail" | "skip";

export type CheckResult = { name: string; status: CheckStatus; detail: string };
