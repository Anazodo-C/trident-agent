import { useState } from 'react'
import { isAddress } from 'viem'
import { AlertTriangle, ArrowUpFromLine, Loader2 } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useWalletStore } from '../../store/walletStore.ts'
import { usdc } from '../../lib/format.ts'

/**
 * Sends USDC out of the agent wallet to an address the user names.
 *
 * The only way funds left before this was spending them. Deposit had a panel,
 * the Gateway panel moved money between the wallet and the Gateway ledger
 * both inside the user's own address, and nothing carried a balance off the
 * platform. Funds a user cannot get back out are not really theirs, whoever
 * holds the signing key.
 *
 * It is also the one irreversible action here. A wrong address cannot be
 * undone, so the send button stays disabled until the address parses and the
 * amount fits the balance, and the confirmation names the network. Everything
 * else on this page is recoverable; this is not.
 */
export function WithdrawPanel() {
  const balances = useWalletStore((s) => s.balances)
  const activeChain = useWalletStore((s) => s.activeChain)
  const refresh = useWalletStore((s) => s.refresh)
  const requestUnlock = useAgentStore((s) => s.requestUnlock)

  const balance = activeChain ? balances[activeChain] : undefined
  /*
   * Unknown, not zero. `?? '0'` here would offer "use max" of nothing and warn
   * that a valid amount is over balance, purely because an RPC did not answer.
   */
  const walletUsdcKnown = balance?.walletUsdc != null
  const walletUsdc = Number(balance?.walletUsdc ?? '0')
  const gatewayUsdc = Number(balance?.gatewayUsdc ?? '0')

  const [toAddress, setToAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const parsed = Number(amount)
  const amountValid = amount.trim() !== '' && Number.isFinite(parsed) && parsed > 0
  const addressValid = isAddress(toAddress.trim())
  const overBalance = amountValid && walletUsdcKnown && parsed > walletUsdc

  /*
   * Gateway funds are withdrawable, just not directly: they have to come back
   * to the wallet first, which is instant on the same chain. Offering that is
   * better than a bare "insufficient balance" against a balance the user can
   * see sitting right above.
   */
  const coverableFromGateway = overBalance && parsed <= walletUsdc + gatewayUsdc

  const ready = addressValid && amountValid && !overBalance && !busy

  async function run() {
    if (!useAgentStore.getState().unlocked) {
      requestUnlock(() => void run())
      return
    }

    setBusy(true)
    setMessage(null)
    try {
      const chain = activeChain ?? undefined
      const res = await api.withdrawCrypto(toAddress.trim(), amount, chain)
      setMessage({
        tone: 'ok',
        text: `Sent ${usdc(amount)} on ${chain ?? 'this network'}. Transaction ${res.txHash.slice(0, 14)}…`,
      })
      setAmount('')
      setToAddress('')
      void refresh(chain)
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Withdrawal failed' })
    } finally {
      setBusy(false)
    }
  }

  /** Bring the shortfall back from Gateway, then let the user send again. */
  async function pullFromGateway() {
    if (!useAgentStore.getState().unlocked) {
      requestUnlock(() => void pullFromGateway())
      return
    }

    setBusy(true)
    setMessage(null)
    try {
      const chain = activeChain ?? undefined
      // Only the shortfall, so funds the agent may still need for a payment are
      // left where they are.
      const needed = (parsed - walletUsdc).toFixed(6)
      await api.gatewayWithdraw(needed, chain)
      setMessage({
        tone: 'ok',
        text: `Moved ${usdc(needed)} out of Gateway into your wallet. Send again to complete.`,
      })
      void refresh(chain)
    } catch (err) {
      setMessage({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Could not move funds out of Gateway',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel p-5">
      <h2 className="heading-mono mb-4">Withdraw</h2>

      <p className="mb-4 text-sm leading-relaxed text-slate-400">
        Send USDC from your agent wallet to any address on{' '}
        <span className="font-mono text-slate-200">{activeChain ?? '—'}</span>.
      </p>

      <label className="mb-3 flex flex-col gap-1.5">
        <span className="heading-mono">To address</span>
        <input
          className="field font-mono"
          placeholder="0x…"
          value={toAddress}
          spellCheck={false}
          onChange={(e) => {
            setToAddress(e.target.value)
            setMessage(null)
          }}
        />
      </label>
      {toAddress.trim() !== '' && !addressValid && (
        <p className="mb-3 text-[11px] text-[#FF4466]">That is not a valid EVM address.</p>
      )}

      <label className="mb-1.5 flex flex-col gap-1.5">
        <span className="heading-mono">Amount (USDC)</span>
        <input
          className="field font-mono"
          placeholder="0.00"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            setMessage(null)
          }}
        />
      </label>
      <p className="mb-4 text-[11px] text-slate-500">
        {walletUsdcKnown ? `${usdc(balance!.walletUsdc!)} in wallet` : 'balance unavailable'}
        {/* Hidden rather than offering "use max" of a figure we do not have. */}
        {walletUsdcKnown && (
          <button
            type="button"
            className="ml-2 text-[#00D4FF] transition-colors hover:text-[#7FE7FF]"
            onClick={() => setAmount(String(walletUsdc))}
          >
            use max
          </button>
        )}
      </p>

      {overBalance && (
        <div className="mb-4 rounded-lg border border-[#FFA040]/30 bg-[#FFA040]/5 p-3">
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[#FFA040]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {coverableFromGateway
              ? 'More than your wallet holds, but your Gateway balance covers the rest.'
              : 'More than this wallet holds.'}
          </p>
          {coverableFromGateway && (
            <button className="btn-ghost mt-2.5 w-full" onClick={pullFromGateway} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Move {usdc((parsed - walletUsdc).toFixed(6))} out of Gateway first
            </button>
          )}
        </div>
      )}

      <button className="btn-primary w-full" onClick={run} disabled={!ready}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
        Send {amountValid && !overBalance ? usdc(amount) : 'USDC'}
      </button>

      {/* Last thing above the button that commits it. */}
      <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
        Sending to the wrong address or the wrong network cannot be undone.
      </p>

      {message && (
        <p
          className={`mt-3 break-words text-[11px] leading-relaxed ${
            message.tone === 'ok' ? 'text-[#00FF88]' : 'text-[#FF4466]'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}
