import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, ArrowRight, Check, Clipboard, ExternalLink, Loader2 } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { useWalletStore } from '../../store/walletStore.ts'
import { copyToClipboard } from '../../lib/format.ts'

/**
 * Fallback only. The destination is whichever chain the Wallet page has
 * selected — hardcoding it meant this panel told people to "Send USDC on
 * ARC-TESTNET" while the Gateway panel beside it was operating on Base. Of
 * every string on this page, this is the one that must not be wrong.
 */
const FALLBACK_CHAIN = 'ARC-TESTNET'

export function DepositPanel() {
  const depositInfo = useWalletStore((s) => s.depositInfo)
  const activeChain = useWalletStore((s) => s.activeChain)
  const activeIsTestnet = useWalletStore((s) =>
    s.activeChain ? s.balances[s.activeChain]?.isTestnet : undefined,
  )
  /**
   * Where funds must land: the chain the agent will actually spend from, in
   * the LABEL form the bridge options use. Comparing a label against an SDK
   * key never matches, which made the panel offer a bridge for a same-chain
   * deposit.
   */
  const homeChain =
    depositInfo?.availableChains?.find((c) => c.chain === activeChain)?.label ??
    activeChain ??
    FALLBACK_CHAIN
  const refresh = useWalletStore((s) => s.refresh)
  const user = useAuthStore((s) => s.user)
  const requestUnlock = useAgentStore((s) => s.requestUnlock)

  const [tab, setTab] = useState<'crypto' | 'fiat'>('crypto')
  const [sourceChain, setSourceChain] = useState(FALLBACK_CHAIN)

  // Switching the destination resets the source to match it, so the default is
  // always a direct deposit rather than an accidental bridge.
  useEffect(() => {
    setSourceChain(homeChain)
  }, [homeChain])
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

  const [bridgeAmount, setBridgeAmount] = useState('')
  const [bridging, setBridging] = useState(false)
  const [bridgeMessage, setBridgeMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  )

  const address = depositInfo?.address ?? user?.eoaAddress ?? ''
  const bridgeSources = depositInfo?.bridgeChains ?? []
  const needsBridge = sourceChain !== homeChain

  useEffect(() => {
    if (!address) {
      setQr(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(address, {
      margin: 1,
      width: 320,
      color: { dark: '#E2E8F0', light: '#0A0E1A' },
    })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null))
    return () => {
      cancelled = true
    }
  }, [address])

  async function runBridge() {
    const key = useAgentStore.getState().unlockedKey
    if (!key) {
      requestUnlock(() => void runBridge())
      return
    }
    if (!bridgeAmount.trim()) return

    setBridging(true)
    setBridgeMessage(null)
    try {
      const res = await api.bridge({
        fromChain: sourceChain,
        toChain: homeChain,
        amount: bridgeAmount,
        agentPrivateKey: key,
      })
      setBridgeMessage({
        tone: res.state === 'error' ? 'err' : 'ok',
        text:
          res.state === 'error'
            ? 'Bridge did not complete. Check your source-chain balance and gas.'
            : `Bridge ${res.state}. ${res.txHash ? `Burn tx ${res.txHash.slice(0, 14)}…` : ''} Funds usually arrive within ${Math.round(res.estimatedArrivalSeconds / 60)} min.`,
      })
      setBridgeAmount('')
      void refresh(key)
    } catch (err) {
      setBridgeMessage({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Bridge failed',
      })
    } finally {
      setBridging(false)
    }
  }

  return (
    <section className="panel p-5">
      <h2 className="heading-mono mb-4">Deposit</h2>

      <div className="mb-5 flex gap-2">
        {(['crypto', 'fiat'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
              tab === t ? 'bg-[#00D4FF]/10 text-[#00D4FF]' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'fiat' ? (
        <div>
          <p className="mb-4 text-sm leading-relaxed text-slate-400">
            Direct fiat onramp is not available — it needs Circle Liquidity Services with a
            separate API key. On testnet, fund this address from the Circle faucet.
          </p>
          <a
            href={depositInfo?.fiatOnramp.testnetFaucetUrl ?? 'https://faucet.circle.com'}
            target="_blank"
            rel="noreferrer noopener"
            className="btn-ghost w-full"
          >
            Open Circle faucet
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <div>
          <label className="mb-4 flex flex-col gap-1.5">
            <span className="heading-mono">Sending from</span>
            <select
              className="field font-mono"
              value={sourceChain}
              onChange={(e) => {
                setSourceChain(e.target.value)
                setBridgeMessage(null)
              }}
            >
              {/*
                The destination is always a valid source — that is the direct
                deposit, no bridge. It is not in bridgeChains for every chain,
                and a <select> whose value has no matching <option> renders the
                first one instead, which said ARC-TESTNET while the address
                below it was for Base.
              */}
              {!bridgeSources.some((c) => c.label === homeChain) && (
                <option value={homeChain}>{homeChain} (direct)</option>
              )}
              {bridgeSources.map((c) => (
                <option key={c.label} value={c.label}>
                  {c.label}
                  {c.label === homeChain ? ' (direct)' : ''}
                </option>
              ))}
            </select>
          </label>

          {!needsBridge ? (
            <>
              {/* Sending to the wrong network is the one mistake here that
                  cannot be undone, so say which network, in the imperative,
                  right above the address being copied. */}
              <p className="mb-3 text-sm text-slate-400">
                Send USDC on <span className="font-mono text-slate-200">{homeChain}</span> to
                your agent wallet:
              </p>

              {activeIsTestnet === false && (
                <p className="mb-3 flex items-start gap-2 rounded-lg border border-[#FFA040]/40 bg-[#FFA040]/10 p-2.5 text-xs leading-relaxed text-[#FFA040]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong className="font-semibold">{homeChain} is a mainnet.</strong> Funds
                    sent here are real. Send on {homeChain} and no other network — anything sent
                    on the wrong network is unrecoverable.
                  </span>
                </p>
              )}

              {qr && (
                <div className="mb-4 flex justify-center">
                  <img
                    src={qr}
                    alt="QR code for the agent wallet address"
                    className="h-40 w-40 rounded-lg border border-[#1A7FFF]/25"
                  />
                </div>
              )}

              <div className="flex items-center gap-2 rounded-lg border border-[#1A7FFF]/25 bg-[#0A0E1A] p-3">
                <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-slate-300">
                  {address || '—'}
                </code>
                <button
                  onClick={async () => setCopied(await copyToClipboard(address))}
                  className="shrink-0 text-slate-500 transition-colors hover:text-[#00D4FF]"
                  aria-label="Copy deposit address"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-[#00FF88]" />
                  ) : (
                    <Clipboard className="h-4 w-4" />
                  )}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-center gap-2 rounded-lg border border-[#1A7FFF]/20 bg-[#0A0E1A] px-3 py-4 font-mono text-[11px] text-slate-400">
                <span className="text-slate-300">{sourceChain}</span>
                <ArrowRight className="h-3.5 w-3.5 text-[#00D4FF]" />
                <span className="text-[#00D4FF]">CCTP</span>
                <ArrowRight className="h-3.5 w-3.5 text-[#00D4FF]" />
                <span className="text-slate-300">{homeChain}</span>
              </div>

              <p className="mb-4 text-xs leading-relaxed text-slate-500">
                USDC on {sourceChain} is burned and re-minted on {homeChain} via Circle CCTP.
                Your agent wallet must already hold the USDC and enough gas on {sourceChain}.
              </p>

              <div className="flex gap-2">
                <input
                  className="field flex-1 font-mono"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={bridgeAmount}
                  onChange={(e) => setBridgeAmount(e.target.value)}
                />
                <button
                  className="btn-ghost shrink-0"
                  onClick={runBridge}
                  disabled={bridging || !bridgeAmount.trim()}
                >
                  {bridging ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Bridge
                </button>
              </div>

              {bridgeMessage && (
                <p
                  className={`mt-3 break-words text-xs ${bridgeMessage.tone === 'ok' ? 'text-[#00FF88]' : 'text-[#FF4466]'}`}
                >
                  {bridgeMessage.text}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
