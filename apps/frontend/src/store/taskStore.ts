import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type {
  BudgetGuidance,
  ChatMessage,
  ExecutionPlan,
  LiveStep,
  StepAnnotation,
  StepUpgrade,
  TaskSummary,
} from '../lib/types.ts'

export type RunPhase = 'idle' | 'planning' | 'awaiting-approval' | 'running' | 'finished'

export interface RunOutcome {
  kind: 'complete' | 'stopped' | 'budget_exceeded' | 'cap_exceeded' | 'fatal' | 'error'
  message: string
  totalSpent: number
}

interface TaskState {
  phase: RunPhase
  goal: string
  taskId: string | null
  plan: ExecutionPlan | null
  /** Registry facts per step index — drives the approval-card warnings. */
  annotations: Record<number, StepAnnotation>
  /** Advisory paid alternatives for free steps. */
  upgrades: StepUpgrade[]
  budgetUsdc: number | null
  /** Set when the goal costs more than the user's cap. The cap is never changed for them. */
  budgetGuidance: BudgetGuidance | null
  liveSteps: LiveStep[]
  totalSpent: number
  outcome: RunOutcome | null
  error: string | null
  stopping: boolean
  /** Aborts the in-flight SSE fetch when the user leaves or resets. */
  abortController: AbortController | null

  /**
   * The chat transcript for the current task. The goal, the agent's write-up
   * of the run, and every follow-up since — this is what the user reads, and
   * the step cards are supporting detail underneath it.
   */
  messages: ChatMessage[]
  chatPending: boolean
  /** Set when a follow-up needs data the run does not have. */
  suggestedGoal: string | null

  history: TaskSummary[]
  historyLoading: boolean

  setGoal: (goal: string) => void
  setBudget: (budget: number | null) => void
  startPlanning: (goal: string) => void
  planReady: (
    taskId: string,
    plan: ExecutionPlan,
    annotations: Record<number, StepAnnotation>,
    upgrades: StepUpgrade[],
    budgetGuidance: BudgetGuidance | null,
  ) => void
  setBudgetGuidance: (guidance: BudgetGuidance | null) => void
  planFailed: (message: string) => void
  beginRun: (steps: LiveStep[], controller: AbortController) => void
  patchStep: (stepIndex: number, patch: Partial<LiveStep>) => void
  setTotalSpent: (total: number) => void
  finishRun: (outcome: RunOutcome) => void
  setStopping: (stopping: boolean) => void
  addMessage: (message: ChatMessage) => void
  addSummary: (taskId: string, summary: string) => void
  setChatPending: (pending: boolean) => void
  setSuggestedGoal: (goal: string | null) => void
  reset: () => void
  loadHistory: () => Promise<void>
}

const initial = {
  phase: 'idle' as RunPhase,
  goal: '',
  taskId: null,
  plan: null,
  annotations: {} as Record<number, StepAnnotation>,
  upgrades: [] as StepUpgrade[],
  budgetUsdc: null,
  budgetGuidance: null as BudgetGuidance | null,
  liveSteps: [] as LiveStep[],
  totalSpent: 0,
  outcome: null,
  error: null,
  stopping: false,
  abortController: null,
  messages: [] as ChatMessage[],
  chatPending: false,
  suggestedGoal: null as string | null,
}

export const useTaskStore = create<TaskState>((set, get) => ({
  ...initial,
  history: [],
  historyLoading: false,

  setGoal: (goal) => set({ goal }),
  setBudget: (budgetUsdc) => set({ budgetUsdc }),

  startPlanning: (goal) =>
    set({
      ...initial,
      goal,
      phase: 'planning',
      history: get().history,
      // The goal is the first turn in the chat, shown immediately rather than
      // waiting for the run that persists it server-side.
      messages: [
        {
          id: `local-goal-${Date.now()}`,
          taskId: null,
          role: 'user',
          content: goal,
          kind: 'text',
          createdAt: Math.floor(Date.now() / 1000),
        },
      ],
    }),

  planReady: (taskId, plan, annotations, upgrades, budgetGuidance) =>
    set({
      taskId,
      plan,
      annotations,
      upgrades,
      budgetGuidance,
      phase: 'awaiting-approval',
      error: null,
    }),

  setBudgetGuidance: (budgetGuidance) => set({ budgetGuidance }),

  planFailed: (message) => set({ phase: 'idle', error: message }),

  beginRun: (liveSteps, abortController) =>
    set({
      phase: 'running',
      liveSteps,
      abortController,
      totalSpent: 0,
      outcome: null,
      error: null,
      stopping: false,
    }),

  patchStep: (stepIndex, patch) =>
    set((state) => ({
      liveSteps: state.liveSteps.map((s) =>
        s.stepIndex === stepIndex ? { ...s, ...patch } : s,
      ),
    })),

  setTotalSpent: (totalSpent) => set({ totalSpent }),

  finishRun: (outcome) =>
    set((state) => ({
      phase: 'finished',
      outcome,
      totalSpent: outcome.totalSpent || state.totalSpent,
      stopping: false,
      abortController: null,
      // Anything still mid-flight when the stream ends did not complete.
      liveSteps: state.liveSteps.map((s) =>
        s.status === 'running' ? { ...s, status: 'failed', error: 'Run ended' } : s,
      ),
    })),

  setStopping: (stopping) => set({ stopping }),

  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),

  /**
   * The summary arrives over SSE, so it has no server-issued message id yet —
   * the backend persisted its own copy in the same moment. A local id keeps the
   * list keyed correctly until the transcript is next loaded from the server.
   */
  addSummary: (taskId, summary) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: `local-summary-${taskId}`,
          taskId,
          role: 'agent',
          content: summary,
          kind: 'summary',
          createdAt: Math.floor(Date.now() / 1000),
        },
      ],
    })),

  setChatPending: (chatPending) => set({ chatPending }),
  setSuggestedGoal: (suggestedGoal) => set({ suggestedGoal }),

  reset: () => {
    get().abortController?.abort()
    set({ ...initial, history: get().history })
  },

  loadHistory: async () => {
    set({ historyLoading: true })
    try {
      const { tasks } = await api.tasks()
      set({ history: tasks, historyLoading: false })
    } catch {
      set({ historyLoading: false })
    }
  },
}))
