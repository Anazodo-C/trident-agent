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

export interface Service {
  id: string
  resource: string
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
  chain: string
  chainId: number
  usdcAddress: string
  walletUsdc: string
  gatewayUsdc: string | null
  gatewayAvailableUsdc: string | null
  /** Set when the on-chain read succeeded but the Gateway API call did not. */
  gatewayWarning: string | null
  native: string
  nativeSymbol: string
  explorerBase: string | null
}

export interface DepositInfo {
  address: string
  chain: string
  chainId: number
  bridgeChains: { label: string; chain: string }[]
  fiatOnramp: { available: boolean; testnetFaucetUrl: string; note: string }
}

export interface KeyMaterial {
  encryptedKey: string
  salt: string
  iv: string
  eoaAddress: string
}
