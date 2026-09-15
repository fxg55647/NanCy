// Shared types for the behavior-comparator harness. See
// docs/architecture/behavior-comparator.md for the full design rationale.

export type Product = {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: string;
  shippingCost: number;
  deliveryDays: number;
  specs: string[];
  description: string;
};

// "baseline" = OpenClaw with only scenario-shop + checkpoint-recorder
// loaded. "nancy" = the same, plus NanCy's own plugin dir in
// plugins.load.paths. These must be two separate isolated profiles —
// plugin loading is gateway-global in OpenClaw, there is no per-agent
// plugin toggle (see docs/architecture/behavior-comparator.md).
export type Branch = "baseline" | "nancy";

// "accepting" (hyväksyvä): answers direct questions and NanCy's
// confirmation with "y", never volunteers unprompted detail.
// "clarifying" (täsmentävä): proactively states the scenario's stored
// budget/constraints after NanCy's advisory note or the assistant's own
// clarifying question.
export type UserProfile = "accepting" | "clarifying";

export type Scenario = {
  id: string;
  label: string;
  initialRequest: string;
  catalog: Product[];
  userSimulator: {
    // The one structured, numerically-checkable constraint (mirrors the
    // spec's own worked example, which is price-based). Other constraints
    // stay free text — see evaluate.ts for why only budget is scored
    // automatically in v1.
    budgetEur: number;
    budgetStatement: string;
    preferences: string[];
  };
  limits: {
    maxTurns: number;
    maxWallClockMs: number;
  };
};

// One message the user-simulator sent, and what (if anything) it revealed
// this turn — evaluate.ts checks "was the user's stated budget respected"
// against *revealed* facts only, never the scenario's hidden fields
// directly, per the spec's explicit warning not to treat a hidden
// preference as an authorization limit unless the user actually said it.
export type UserTurn = {
  turnIndex: number;
  ts: string;
  message: string;
  revealedBudgetEur?: number;
};

export type AssistantTurn = {
  turnIndex: number;
  ts: string;
  rawJson: unknown;
  assistantText: string;
};

export type DriverTurnLog = {
  scenarioId: string;
  branch: Branch;
  userProfile: UserProfile;
  runId: string;
  sessionKey: string;
  startedAt: string;
  endedAt?: string;
  userTurns: UserTurn[];
  assistantTurns: AssistantTurn[];
  stopReason: "purchase_detected" | "user_simulator_exhausted" | "max_turns" | "max_wall_clock" | "cli_error";
};

export type RunPaths = {
  runDir: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  catalogPath: string;
  purchaseStateFile: string;
  recorderOutputDir: string;
  nancyLogDir: string;
  turnLogPath: string;
};
