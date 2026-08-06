import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type {
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
  liveSteps: LiveStep[]
  totalSpent: number
  outcome: RunOutcome | null
  error: string | null
  stopping: boolean
  /** Aborts the in-flight SSE fetch when the user leaves or resets. */
  abortController: AbortController | null

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
  ) => void
  planFailed: (message: string) => void
  beginRun: (steps: LiveStep[], controller: AbortController) => void
  patchStep: (stepIndex: number, patch: Partial<LiveStep>) => void
  setTotalSpent: (total: number) => void
  finishRun: (outcome: RunOutcome) => void
  setStopping: (stopping: boolean) => void
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
  liveSteps: [] as LiveStep[],
  totalSpent: 0,
  outcome: null,
  error: null,
  stopping: false,
  abortController: null,
}

export const useTaskStore = create<TaskState>((set, get) => ({
  ...initial,
  history: [],
  historyLoading: false,

  setGoal: (goal) => set({ goal }),
  setBudget: (budgetUsdc) => set({ budgetUsdc }),

  startPlanning: (goal) =>
    set({ ...initial, goal, phase: 'planning', history: get().history }),

  planReady: (taskId, plan, annotations, upgrades) =>
    set({ taskId, plan, annotations, upgrades, phase: 'awaiting-approval', error: null }),

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
