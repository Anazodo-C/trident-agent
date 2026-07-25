import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { ArrowRight, Check, Clipboard, ExternalLink, Loader2 } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useAuthStore } from '../../store/authStore.ts'
import { useWalletStore } from '../../store/walletStore.ts'
import { copyToClipboard } from '../../lib/format.ts'

const HOME_CHAIN = 'ARC-TESTNET'

export function DepositPanel() {
  const depositInfo = useWalletStore((s) => s.depositInfo)
  const refresh = useWalletStore((s) => s.refresh)
  const user = useAuthStore((s) => s.user)
  const requestUnlock = useAgentStore((s) => s.requestUnlock)

  const [tab, setTab] = useState<'crypto' | 'fiat'>('crypto')
  const [sourceChain, setSourceChain] = useState(HOME_CHAIN)
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

  const [bridgeAmount, setBridgeAmount] = useState('')
  const [bridging, setBridging] = useState(false)
  const [bridgeMessage, setBridgeMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    null,
  )

  const address = depositInfo?.address ?? user?.eoaAddress ?? ''
  const chains = depositInfo?.bridgeChains ?? []
  const needsBridge = sourceChain !== HOME_CHAIN

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
        toChain: HOME_CHAIN,
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
              {chains.length === 0 && <option value={HOME_CHAIN}>{HOME_CHAIN}</option>}
              {chains.map((c) => (
                <option key={c.label} value={c.label}>
                  {c.label}
                  {c.label === HOME_CHAIN ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>

          {!needsBridge ? (
            <>
              <p className="mb-3 text-sm text-slate-400">
                Send USDC on <span className="font-mono text-slate-200">{HOME_CHAIN}</span> to
                your agent wallet:
              </p>

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
                <span className="text-slate-300">{HOME_CHAIN}</span>
              </div>

              <p className="mb-4 text-xs leading-relaxed text-slate-500">
                USDC on {sourceChain} is burned and re-minted on {HOME_CHAIN} via Circle CCTP.
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
