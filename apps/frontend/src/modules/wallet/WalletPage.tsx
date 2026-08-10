import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Clipboard,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { api } from '../../lib/api.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { useWalletStore } from '../../store/walletStore.ts'
import { copyToClipboard, shortAddress, usdc } from '../../lib/format.ts'
import type { PendingDeposit } from '../../lib/types.ts'
import { DepositPanel } from './DepositPanel.tsx'
import { WithdrawPanel } from './WithdrawPanel.tsx'

export function WalletPage() {
  const refreshUser = useAuthStore((s) => s.refreshUser)
  const unlockedKey = useAgentStore((s) => s.unlockedKey)
  const { activeChain, depositInfo, loading, error, refresh, refreshAll, setActiveChain } =
    useWalletStore()

  useEffect(() => {
    void refreshAll(unlockedKey ?? undefined)
  }, [refreshAll, unlockedKey])

  const chains = depositInfo?.availableChains ?? []

  /*
   * Two networks, not a chain list.
   *
   * The backend still returns each fundable chain, because deposits and
   * withdrawals land on a specific one. But a user chooses between testnet and
   * mainnet — which mainnet chain their money sits on is the agent's business,
   * and it moves it as needed. Mainnet resolves to the first chain the backend
   * offers, which it orders with the funding chain leading.
   */
  const networks = [
    ...chains.filter((c) => c.isTestnet).slice(0, 1).map((c) => ({ ...c, name: 'Arc Testnet' })),
    ...chains.filter((c) => !c.isTestnet).slice(0, 1).map((c) => ({ ...c, name: 'Mainnet' })),
  ]

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg uppercase tracking-widest text-slate-100">Wallet</h1>
          <p className="mt-2 text-sm text-slate-400">
            One self-custody address, {networks.length > 1 ? 'on testnet and mainnet' : 'on testnet'}.
          </p>
        </div>
        <button
          className="btn-ghost"
          onClick={() => refreshAll(unlockedKey ?? undefined)}
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mb-5 rounded-xl border border-[#FF4466]/40 bg-[#FF4466]/10 p-4 text-sm text-[#FF4466]">
          {error}
        </div>
      )}

      {/*
        Which chain an operation lands on used to be implied by a column set at
        signup, which is how a Gateway deposit could go to a different chain
        than the agent pays from. It is now a visible, deliberate choice.
      */}
      {networks.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {networks.map((n) => (
            <button
              key={n.chain}
              onClick={() => {
                setActiveChain(n.chain)
                // Read that network now rather than showing a stale figure
                // until the next refresh.
                void refresh(unlockedKey ?? undefined, n.chain)
              }}
              className={`badge px-3 py-1.5 transition-colors ${
                n.chain === activeChain
                  ? 'bg-[#00D4FF]/15 text-[#00D4FF] ring-1 ring-[#00D4FF]/50'
                  : 'bg-[#1A7FFF]/10 text-slate-400 hover:text-slate-200'
              }`}
            >
              {n.name}
              <span className={n.isTestnet ? 'ml-2 text-slate-500' : 'ml-2 text-[#FFA040]'}>
                {n.isTestnet ? 'testnet' : 'real funds'}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <BalancePanel />
        <DepositPanel />
        <WithdrawPanel />
        <GatewayPanel />
        <SpendingCapPanel onSaved={refreshUser} />
        <MainnetPanel onSaved={refreshUser} />
      </div>

      <p className="mt-6 text-xs leading-relaxed text-slate-600">
        {depositInfo?.faucet.note}
      </p>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel p-5">
      <h2 className="heading-mono mb-4">{title}</h2>
      {children}
    </section>
  )
}

function BalancePanel() {
  const balances = useWalletStore((s) => s.balances)
  const activeChain = useWalletStore((s) => s.activeChain)
  const pendingDeposits = useWalletStore((s) => s.pendingDeposits)
  const [copied, setCopied] = useState(false)

  const entries = Object.values(balances)
  const balance = (activeChain ? balances[activeChain] : undefined) ?? entries[0]

  /*
   * On mainnet the headline Gateway figure is the cross-chain total, because
   * the agent bridges on demand — a per-chain number would report zero on a
   * chain a payment is about to succeed on. `gatewaySpendableUsdc` is that sum;
   * it falls back to this chain's own ledger when the aggregate read failed.
   */
  const gatewayTotal = balance?.gatewaySpendableUsdc ?? balance?.gatewayUsdc ?? null

  // Only chains actually holding something, so the disclosure is a short list.
  const perChain = entries.filter(
    (b) => !b.isTestnet && b.gatewayUsdc != null && Number(b.gatewayUsdc) > 0,
  )

  const explorerUrl =
    balance?.explorerBase && balance.eoaAddress
      ? `${balance.explorerBase}/address/${balance.eoaAddress}`
      : null

  return (
    <Panel title="Balance">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm text-slate-200">
          {shortAddress(balance?.eoaAddress, 6)}
        </code>
        <button
          onClick={async () => setCopied(await copyToClipboard(balance?.eoaAddress ?? ''))}
          className="text-slate-500 transition-colors hover:text-[#00D4FF]"
          aria-label="Copy address"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[#00FF88]" />
          ) : (
            <Clipboard className="h-3.5 w-3.5" />
          )}
        </button>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-slate-500 transition-colors hover:text-[#00D4FF]"
            aria-label="View on explorer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/*
        One card for the selected network, not one per settlement chain.
        Which chain an invoice names is the agent's problem — it picks per
        service and bridges when the money is elsewhere — so listing eleven of
        them asked the user to manage something they do not decide.
      */}
      {!balance ? (
        <p className="text-sm text-slate-500">Loading balance…</p>
      ) : (
        <div className="rounded-lg border border-[#00D4FF]/40 bg-[#00D4FF]/5 p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <span className="font-mono text-xs uppercase tracking-widest text-slate-300">
              {balance.isTestnet ? 'Arc Testnet' : 'Mainnet'}
            </span>
            <span
              className={`badge ${
                balance.isTestnet
                  ? 'bg-[#1A7FFF]/15 text-slate-400'
                  : 'bg-[#FFA040]/15 text-[#FFA040]'
              }`}
            >
              {balance.isTestnet ? 'testnet' : 'real funds'}
            </span>
          </div>

          <dl className="flex flex-col gap-2">
            {/* Funds the plain-x402 rail, and the burn when a bridge is needed. */}
            <Row label="USDC (wallet)" value={usdc(balance.walletUsdc)} />
            {/* Funds the Gateway rail. On mainnet this is the cross-chain total. */}
            <Row
              label="USDC (gateway)"
              value={
                (balance.isTestnet ? balance.gatewayUsdc : gatewayTotal) != null
                  ? usdc((balance.isTestnet ? balance.gatewayUsdc : gatewayTotal)!)
                  : 'unavailable'
              }
              dim={(balance.isTestnet ? balance.gatewayUsdc : gatewayTotal) == null}
            />
            {/*
              Payments themselves cost no gas — both rails are signature-only and
              the seller submits. This is still here because four things do spend
              it: every free-tier call, a Gateway deposit or withdrawal, and the
              CCTP burn. On Arc the gas token is also called USDC but is a
              separate 18-decimal balance from the ERC-20 above.
            */}
            <Row
              label={`${balance.nativeSymbol} (native, for gas)`}
              value={Number.parseFloat(balance.native).toFixed(5)}
            />
          </dl>

          {!balance.isTestnet && (
            <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
              Held across networks. The agent moves it to whichever chain a
              service settles on.
            </p>
          )}

          {/*
            Where it actually sits, folded away. A cross-chain total is the right
            headline now the bridge works, but the split still matters when a
            transfer is mid-flight or a chain is short.
          */}
          {!balance.isTestnet && perChain.length > 0 && (
            <details className="mt-2.5">
              <summary className="cursor-pointer text-[11px] text-slate-500 transition-colors hover:text-slate-300">
                Where it sits
              </summary>
              <dl className="mt-2 flex flex-col gap-1.5 border-l border-[#1A7FFF]/20 pl-3">
                {perChain.map((b) => (
                  <Row key={b.chain} label={b.chain} value={usdc(b.gatewayUsdc ?? '0')} />
                ))}
              </dl>
            </details>
          )}

          {pendingDeposits[balance.chain] && (
            <PendingDepositNote deposit={pendingDeposits[balance.chain]!} />
          )}

          {balance.gatewayWarning && (
            <p className="mt-2 break-words text-[11px] text-[#FFA040]">{balance.gatewayWarning}</p>
          )}
        </div>
      )}

      {balance?.gatewayWarning && (
        <p className="mt-4 break-words rounded-lg border border-[#FFA040]/30 bg-[#FFA040]/5 p-2.5 text-[11px] leading-relaxed text-[#FFA040]">
          Gateway balance unavailable: {balance.gatewayWarning}
        </p>
      )}
    </Panel>
  )
}

/**
 * A deposit that has settled on chain but is still waiting on finality.
 *
 * Gateway credits nothing until the source chain finalises, so the wallet
 * shows a successful transfer and an unchanged balance for up to twenty
 * minutes. Saying so — with the clock running — is the difference between
 * "waiting" and "my money is gone".
 */
function PendingDepositNote({ deposit }: { deposit: PendingDeposit }) {
  const [now, setNow] = useState(() => Date.now())

  // A minute is fine: this is a ~20 minute wait, not a progress bar.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const minutes = Math.max(0, Math.floor((now - deposit.at) / 60_000))

  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#FFA040]/35 bg-[#FFA040]/10 p-2.5 text-[11px] leading-relaxed text-[#FFA040]">
      <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <strong className="font-semibold">{usdc(deposit.amount)} USDC deposited</strong>, waiting
        on {deposit.chain} finality — {finalityNote(deposit.chain)}.{' '}
        {minutes === 0 ? 'Just now.' : `${minutes} min ago.`} The transfer is already on chain;
        Gateway credits it once the chain finalises.
      </span>
    </div>
  )
}

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-slate-400">{label}</dt>
      <dd className={`font-mono text-sm ${dim ? 'text-slate-600' : 'text-[#00D4FF]'}`}>{value}</dd>
    </div>
  )
}

function GatewayPanel() {
  const unlockedKey = useAgentStore((s) => s.unlockedKey)
  const requestUnlock = useAgentStore((s) => s.requestUnlock)
  const refreshAll = useWalletStore((s) => s.refreshAll)
  const notePendingDeposit = useWalletStore((s) => s.notePendingDeposit)
  const activeChain = useWalletStore((s) => s.activeChain)
  const isTestnet = useWalletStore((s) => (s.activeChain ? s.balances[s.activeChain]?.isTestnet : true))

  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [busy, setBusy] = useState<'deposit' | 'withdraw' | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  async function run(kind: 'deposit' | 'withdraw') {
    const key = useAgentStore.getState().unlockedKey
    if (!key) {
      requestUnlock(() => void run(kind))
      return
    }
    const amount = kind === 'deposit' ? depositAmount : withdrawAmount
    if (!amount.trim()) return

    setBusy(kind)
    setMessage(null)
    try {
      // Explicitly on the selected chain — never on a stored default.
      const chain = activeChain ?? undefined
      const baselineTotal = chain
        ? (useWalletStore.getState().balances[chain]?.gatewayUsdc ?? null)
        : null

      const res =
        kind === 'deposit'
          ? await api.gatewayDeposit(amount, key, chain)
          : await api.gatewayWithdraw(amount, key, chain)

      if (kind === 'deposit' && chain) {
        // The transfer is on chain, but Gateway will not count it until the
        // source chain finalises. Remember it so the flat balance in the
        // meantime reads as "waiting" rather than "lost".
        notePendingDeposit({
          chain,
          amount,
          txHash: (res as { depositTxHash?: string }).depositTxHash ?? '',
          at: Date.now(),
          baselineTotal,
        })
      }

      setMessage({
        tone: 'ok',
        text:
          kind === 'deposit'
            ? `Deposited ${amount} USDC on ${chain}. It will show in the Gateway balance once ${chain} finalises — ${finalityNote(chain)}.`
            : `Withdrew ${amount} USDC on ${chain}. Gateway balance: ${res.newGatewayBalance}`,
      })
      if (kind === 'deposit') setDepositAmount('')
      else setWithdrawAmount('')
      void refreshAll(key)
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Transaction failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel title="Gateway">
      <p className="mb-4 text-sm leading-relaxed text-slate-400">
        Your agent pays x402 services from its Gateway balance on the chain the service settles
        on. Move USDC in before a run.
      </p>

      {/* The single most expensive mistake here is funding the wrong chain. */}
      <p className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">Acting on</span>
        <span className="font-mono text-slate-200">{activeChain ?? '—'}</span>
        {isTestnet === false && (
          <span className="badge bg-[#FFA040]/15 text-[#FFA040]">real funds</span>
        )}
      </p>

      <div className="flex flex-col gap-4">
        <AmountRow
          label="Wallet → Gateway"
          value={depositAmount}
          onChange={setDepositAmount}
          busy={busy === 'deposit'}
          disabled={busy !== null}
          onSubmit={() => run('deposit')}
          Icon={ArrowDownToLine}
          action="Deposit"
        />
        <AmountRow
          label="Gateway → Wallet"
          value={withdrawAmount}
          onChange={setWithdrawAmount}
          busy={busy === 'withdraw'}
          disabled={busy !== null}
          onSubmit={() => run('withdraw')}
          Icon={ArrowUpFromLine}
          action="Withdraw"
        />
      </div>

      {!unlockedKey && (
        <p className="mt-4 text-xs text-slate-500">
          You will be asked to unlock your wallet before the transaction is signed.
        </p>
      )}

      {message && (
        <p
          className={`mt-4 break-words text-xs ${message.tone === 'ok' ? 'text-[#00FF88]' : 'text-[#FF4466]'}`}
        >
          {message.text}
        </p>
      )}
    </Panel>
  )
}

/**
 * How long Gateway takes to credit a deposit on a given chain.
 *
 * Only Base is stated with a figure, because that is the one measured. Every
 * other chain gets the honest general answer rather than a number invented to
 * look precise.
 */
function finalityNote(chain?: string): string {
  if (chain === 'base') return 'about 18-21 minutes on Base'
  return 'usually a few minutes, depending on the chain'
}

function AmountRow({
  label,
  value,
  onChange,
  busy,
  disabled,
  onSubmit,
  Icon,
  action,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  busy: boolean
  disabled: boolean
  onSubmit: () => void
  Icon: typeof ArrowDownToLine
  action: string
}) {
  return (
    <div>
      <span className="heading-mono">{label}</span>
      <div className="mt-1.5 flex gap-2">
        <input
          className="field flex-1 font-mono"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          className="btn-ghost shrink-0"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
          <span className="hidden sm:inline">{action}</span>
        </button>
      </div>
    </div>
  )
}

function SpendingCapPanel({ onSaved }: { onSaved: () => void }) {
  const user = useAuthStore((s) => s.user)
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (user?.spendingCapUsdc !== undefined) setCap(String(user.spendingCapUsdc))
  }, [user?.spendingCapUsdc])

  async function save() {
    const parsed = Number.parseFloat(cap)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage({ tone: 'err', text: 'Enter a positive number.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await api.setSpendingCap(parsed)
      onSaved()
      setMessage({ tone: 'ok', text: `Cap set to $${parsed.toFixed(2)} USDC per run.` })
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Spending Cap">
      <p className="mb-4 text-sm leading-relaxed text-slate-400">
        Hard ceiling on what a single run may spend. Trident checks this before every step,
        independently of any per-run budget.
      </p>
      <div className="flex gap-2">
        <input
          className="field flex-1 font-mono"
          inputMode="decimal"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
        <button className="btn-primary shrink-0" onClick={save} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </button>
      </div>
      {message && (
        <p className={`mt-3 text-xs ${message.tone === 'ok' ? 'text-[#00FF88]' : 'text-[#FF4466]'}`}>
          {message.text}
        </p>
      )}
    </Panel>
  )
}

/**
 * Mainnet spending is opt-in and off by default.
 *
 * Turning it on is the moment the agent stops playing with faucet funds and
 * starts spending real USDC autonomously once a plan is approved — so it is a
 * deliberate, separate action, stated plainly rather than buried in a setting.
 */
function MainnetPanel({ onSaved }: { onSaved: () => void }) {
  const user = useAuthStore((s) => s.user)
  const enabled = user?.mainnetEnabled ?? false
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      await api.setMainnet(next, 'BASE')
      onSaved()
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Mainnet Spending">
      <div className="mb-4 flex items-center gap-2">
        <span
          className={`badge ${enabled ? 'bg-[#FFA040]/10 text-[#FFA040]' : 'bg-[#00FF88]/10 text-[#00FF88]'}`}
        >
          {enabled ? 'real funds enabled' : 'testnet only'}
        </span>
        {enabled && (
          <span className="badge bg-slate-500/10 text-slate-400">
            {user?.mainnetChain ?? 'BASE'}
          </span>
        )}
      </div>

      <p className="mb-4 text-sm leading-relaxed text-slate-400">
        {enabled
          ? 'Your agent can settle on Base with real USDC. Testnet is still preferred whenever a service supports it.'
          : 'Your agent can only spend testnet USDC. Almost every service in the registry settles on mainnet, so enabling this unlocks the catalog.'}
      </p>

      {!enabled && !confirming && (
        <button className="btn-ghost w-full" onClick={() => setConfirming(true)}>
          Enable mainnet spending
        </button>
      )}

      {!enabled && confirming && (
        <div className="rounded-lg border border-[#FFA040]/40 bg-[#FFA040]/10 p-3">
          <p className="mb-3 text-xs leading-relaxed text-[#FFA040]">
            Once enabled, an approved plan spends <strong>real USDC</strong> from your agent
            wallet without further confirmation. Your spending cap and per-run budget stay in
            force. Fund the wallet on Base before running anything.
          </p>
          <div className="flex gap-2">
            <button className="btn-danger flex-1" onClick={() => apply(true)} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              I understand — enable
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {enabled && (
        <button className="btn-ghost w-full" onClick={() => apply(false)} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Switch back to testnet only
        </button>
      )}

      {error && <p className="mt-3 text-xs text-[#FF4466]">{error}</p>}
    </Panel>
  )
}
