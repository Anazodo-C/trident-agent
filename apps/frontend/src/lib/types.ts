export interface User {
  id: string
  email: string | null
  walletAddress: string | null
  eoaAddress: string | null
  spendingCapUsdc: number
  defaultChain: string
}

export type Verification = 'verified-x402' | 'unverified' | 'unreachable'

export interface Service {
  id: string
  name: string
  description: string
  category: string
  baseUrl: string
  endpoints: string[]
  priceRangeUsdc: string
  provider: '1P' | '3P'
  tags: string[]
  verification: Verification
  note?: string
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
