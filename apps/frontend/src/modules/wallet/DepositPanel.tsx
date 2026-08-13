import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, Check, Clipboard, ExternalLink } from 'lucide-react'
import { useAuthStore } from '../../store/authStore.ts'
import { useWalletStore } from '../../store/walletStore.ts'
import { copyToClipboard } from '../../lib/format.ts'

/**
 * Fallback only. The destination is whichever chain the Wallet page has
 * selected, hardcoding it meant this panel told people to "Send USDC on
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
   * Where funds must land, resolved to the label a user would see on their own
   * wallet rather than the SDK's key for it. The store holds keys like `base`;
   * printing one of those in "Send USDC on ..." asks somebody to match a string
   * against their wallet's network list and hope.
   */
  const homeChain =
    depositInfo?.availableChains?.find((c) => c.chain === activeChain)?.label ??
    activeChain ??
    FALLBACK_CHAIN
  const user = useAuthStore((s) => s.user)

  const [tab, setTab] = useState<'crypto' | 'faucet'>('crypto')
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

  const address = depositInfo?.address ?? user?.eoaAddress ?? ''

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

  return (
    <section className="panel p-5">
      <h2 className="heading-mono mb-4">Deposit</h2>

      <div className="mb-5 flex gap-2">
        {(['crypto', 'faucet'] as const).map((t) => (
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

      {tab === 'faucet' ? (
        <div>
          <p className="mb-4 text-sm leading-relaxed text-slate-400">
            Fund this address from the Circle faucet on testnet, or send USDC to it from any
            wallet. Card payments are not supported yet.
          </p>
          <a
            href={depositInfo?.faucet.testnetFaucetUrl ?? 'https://faucet.circle.com'}
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
          {/*
            One destination, stated plainly.

            The network picker used to sit here, above the address, which made
            choosing a chain the first thing a user did with real money. The
            agent moves funds to whatever network a service settles on, so that
            choice never needed to be theirs, and every option in a list above
            an address is a way to lose funds by picking wrong.
          */}
          <p className="mb-3 text-sm text-slate-400">
            Send USDC on <span className="font-mono text-slate-200">{homeChain}</span> to
            your agent wallet:
          </p>

          {activeIsTestnet === false && (
            <p className="mb-3 flex items-start gap-2 rounded-lg border border-[#FFA040]/40 bg-[#FFA040]/10 p-2.5 text-xs leading-relaxed text-[#FFA040]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong className="font-semibold">{homeChain} is a mainnet.</strong> Funds
                sent here are real. Send on {homeChain}. USDC sent on another EVM network is
                still yours but may not be reachable here; USDC sent on a non-EVM network is
                lost for good.
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

          {activeIsTestnet === false && (
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              This is the only network you need to fund. When a service settles
              somewhere else, the agent moves what that call needs and pays the
              fee on the far side.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
