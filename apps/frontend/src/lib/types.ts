export interface User {
  id: string
  email: string | null
  walletAddress: string | null
  eoaAddress: string | null
  spendingCapUsdc: number
  defaultChain: string
  mainnetEnabled: boolean
  mainnetChain: string
}

/** curated = in Circle's marketplace; active = used recently; untested = no recorded traffic. */
export type TrustTier = 'curated' | 'active' | 'untested'

export type ServiceSource = 'free' | 'x402'

export interface Service {
  id: string
  resource: string
  source: ServiceSource
  premiumCategory: string | null
  serviceName: string
  description: string
  tags: string[]
  host: string
  network: string | null
  chainKey: string | null
  isTestnet: boolean
  priceUsdc: number
  httpMethod: 'GET' | 'POST'
  curated: boolean
  calls30d: number
  payers30d: number
  lastCalledAt: string | null
  iconUrl: string | null
  trust: TrustTier
  /** Whether this wallet can settle it under the current chain policy. */
  payable: boolean
  payChain: string | null
  payPriceUsdc: number
  payIsTestnet: boolean
  blockedReason: string | null
}

export interface RegistrySync {
  startedAt: number | null
  completedAt: number | null
  totalKept: number
  status: string | null
  error: string | null
  serviceCount: number
}

export interface PremiumUpgrade {
  serviceName: string
  resource: string
  description: string
  priceUsdc: number
  chain: string | null
  curated: boolean
  calls30d: number
  /** False when the user has not enabled mainnet yet. */
  available: boolean
}

/** Advisory: what paying would buy for a step currently using a free API. */
export interface StepUpgrade {
  stepIndex: number
  freeServiceName: string
  category: string
  options: PremiumUpgrade[]
}

/** Registry-sourced facts about a planned step — not the model's claims. */
export interface StepAnnotation {
  trust: TrustTier
  calls30d: number
  host: string
  chain: string | null
  isTestnet: boolean
  blockedReason?: string
  warning?: string
}

export interface PlanStep {
  stepIndex: number
  serviceName: string
  endpointUrl: string
  httpMethod: 'GET' | 'POST'
  params: Record<string, string | number | boolean>
  purpose: string
  estimatedCostUsdc: number
}

export interface ExecutionPlan {
  goal: string
  steps: PlanStep[]
  totalEstimatedCostUsdc: number
  reasoning: string
  alternativeSteps: PlanStep[]
  minCostUsdc?: number
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface LiveStep {
  stepIndex: number
  serviceName: string
  endpointUrl: string
  purpose: string
  estimatedCostUsdc: number
  status: StepStatus
  cost?: number
  txRef?: string
  error?: string
  result?: unknown
  /** Carried over from an earlier attempt — already paid for, not re-charged. */
  replayed?: boolean
}

/** A turn in the chat transcript. 'plan_offer' means a new run is required. */
export type MessageKind = 'text' | 'summary' | 'plan_offer'

export interface ChatMessage {
  id: string
  taskId: string | null
  role: 'user' | 'agent'
  content: string
  kind: MessageKind
  createdAt: number
}

/** One costed way to accomplish the goal, quoted when the limit will not cover it. */
export interface BudgetOption {
  kind: 'cheapest' | 'reliable'
  totalUsdc: number
  /** The cap the user would have to set for this route to run. */
  minimumCapUsdc: number
  /** 0–100, from the registry's trust tier and recorded usage. */
  quality: number
  services: string
  rationale: string
  steps: PlanStep[]
}

export interface BudgetGuidance {
  capUsdc: number
  budgetUsdc: number | null
  ceilingUsdc: number
  rangeUsdc: { min: number; max: number } | null
  options: BudgetOption[]
  message: string
}

/** Registry-priced totals for the plan — never the model's own estimates. */
export interface PlanCosting {
  ceilingUsdc: number
  capUsdc: number
  primaryUsdc: number
  alternativeUsdc: number | null
}

/** A landing-page carousel card: authored copy plus live registry facts. */
export interface ShowcaseCard {
  resource: string
  category: string
  prompt: string
  does: string
  serviceName: string
  host: string
  priceUsdc: number
  calls30d: number
  curated: boolean
  source: ServiceSource
}

export interface TaskSummary {
  id: string
  goal: string
  status: string
  totalCostUsdc: number
  budgetUsdc: number | null
  createdAt: number
  completedAt: number | null
  stepCount: number
  stepsDone: number
}

export interface TaskStepDetail {
  id: string
  stepIndex: number
  serviceName: string
  endpointUrl: string
  httpMethod: string
  params: unknown
  estimatedCostUsdc: number
  actualCostUsdc: number | null
  status: string
  responseSummary: string | null
  txRef: string | null
  startedAt: number | null
  completedAt: number | null
}

export interface WalletBalance {
  eoaAddress: string
  /** The chain this balance is for — the request's chain, not a stored default. */
  chain: string
  isTestnet: boolean
  chainId: number
  usdcAddress: string
  walletUsdc: string
  gatewayUsdc: string | null
  gatewayAvailableUsdc: string | null
  /**
   * The Gateway ledger summed across every mainnet domain.
   *
   * A total, not a spendable figure — an invoice draws the ledger on its own
   * chain and nowhere else. What makes it usable anywhere is the agent bridging
   * on demand, which costs a fee and takes minutes.
   */
  gatewaySpendableUsdc: string | null
  /** Set when the on-chain read succeeded but the Gateway API call did not. */
  gatewayWarning: string | null
  native: string
  nativeSymbol: string
  explorerBase: string | null
}

/**
 * A deposit that has settled on chain but not yet been credited by Gateway.
 *
 * Gateway only counts a deposit once the source chain reaches finality, so the
 * transfer succeeds and the balance stays flat for many minutes. Without a
 * record of the wait, that reads as a lost deposit.
 */
export interface PendingDeposit {
  chain: string
  amount: string
  txHash: string
  /** Epoch ms, for showing elapsed time. */
  at: number
  /** Gateway total at deposit time — the balance to beat before clearing this. */
  baselineTotal: string | null
}

/** A chain this account is permitted to hold funds on. */
export interface ChainOption {
  /** SDK key, e.g. `base` — what the balance and Gateway routes expect. */
  chain: string
  /** Label form, e.g. `BASE` — what the bridge options speak. */
  label: string
  chainId: number
  isTestnet: boolean
}

export interface DepositInfo {
  address: string
  chain: string
  chainId: number
  /** Every chain the account may use — testnet always, mainnet once opted in. */
  availableChains: ChainOption[]
  bridgeChains: { label: string; chain: string }[]
  /** No onramp exists; the faucet and a direct transfer are the ways in. */
  faucet: { testnetFaucetUrl: string; note: string }
}

export interface KeyMaterial {
  userId: string
  encryptedKey: string
  salt: string
  iv: string
  eoaAddress: string
  /** The count this blob was encrypted at — decrypt with exactly this. */
  iterations: number
  /** The count it should be re-encrypted at, if it is behind. */
  targetIterations: number
}

export interface StatBreakdown {
  label: string
  count: number
  amountUsdc: number
}

export interface StatTimePoint {
  day: string
  runs: number
  spentUsdc: number
  activeUsers: number
}

export interface Stats {
  scope: 'me' | 'global'
  totals: {
    uniqueUsers: number
    walletsCreated: number
    runs: number
    stepsExecuted: number
    transactions: number
    totalSpentUsdc: number
    endpointsCalled: number
    servicesUsed: number
    freeCalls: number
    paidCalls: number
  }
  successRate: number
  avgCostPerRun: number
  avgStepsPerRun: number
  runsByStatus: StatBreakdown[]
  topServices: StatBreakdown[]
  spendByChain: StatBreakdown[]
  failureReasons: StatBreakdown[]
  daily: StatTimePoint[]
  registry: { total: number; free: number; x402: number; curated: number }
}
