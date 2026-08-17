import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { AlertTriangle, Check, Clipboard, ExternalLink } from 'lucide-react'
import { useWalletStore } from '../../store/walletStore.ts'
import { copyToClipboard } from '../../lib/format.ts'

/**
 * Where to send funds, and to which of two wallets.
 *
 * This panel is the only place in the product where getting a string wrong
 * loses money that cannot be recovered, so it is built to have no way of
 * showing an address that belongs to a network other than the selected one.
 *
 * Three rules follow from that, and none of them are stylistic:
 *
 *  - The address travels with the chain in one payload. There is no refetch on
 *    toggle, so there is no window in which a slow response labels one
 *    network's address with another's.
 *  - There is no fallback. A missing address renders as a missing address. The
 *    previous version fell back to `user.eoaAddress`, a legacy field that is
 *    null for every new account and, for the one migrated account, points at
 *    the wallet its owner migrated *out of*.
 *  - The network is chosen here, at the point of deposit, rather than inherited
 *    silently from a chip elsewhere on the page.
 */
export function DepositPanel() {
  const depositInfo = useWalletStore((s) => s.depositInfo)
  const activeChain = useWalletStore((s) => s.activeChain)

  const [tab, setTab] = useState<'crypto' | 'faucet'>('crypto')
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  /** Null until the user picks, so the page's selection leads until then. */
  const [picked, setPicked] = useState<string | null>(null)

  const chains = useMemo(() => depositInfo?.availableChains ?? [], [depositInfo])

  /*
   * Resolved in this order, and it matters: an explicit choice here, then
   * whatever the page is showing, then the first fundable chain. Each step is a
   * lookup in the list rather than a value carried alongside it, so a selection
   * that no longer exists (mainnet turned back off, say) degrades to a real
   * entry instead of leaving a stale address on screen.
   */
  const selected =
    chains.find((c) => c.chain === picked) ??
    chains.find((c) => c.chain === activeChain) ??
    chains[0] ??
    null

  const address = selected?.address ?? ''
  const hasBothNetworks = chains.some((c) => c.isTestnet) && chains.some((c) => !c.isTestnet)

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

  // Copying is per address; a tick left over from the previous network reads as
  // confirmation of the wrong thing.
  useEffect(() => setCopied(false), [address])

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
            The Circle faucet funds the testnet wallet, which is the one the agent spends from
            until you enable mainnet. Send it to the Arc Testnet address below, not the mainnet
            one.
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
            The network picker sits above the address deliberately.

            It was removed once, on the reasoning that the agent moves funds
            wherever a service settles so the choice was never the user's. That
            held while there was one wallet. There are now two, in separate
            Circle environments at separate addresses, and neither key can sign
            for the other, so the choice is unavoidable and belongs in front of
            the address rather than implied by a chip further up the page.
          */}
          {chains.length > 1 && (
            <label className="mb-3 block">
              <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-slate-500">
                Network
              </span>
              <select
                value={selected?.chain ?? ''}
                onChange={(e) => setPicked(e.target.value)}
                className="w-full rounded-lg border border-[#1A7FFF]/25 bg-[#0A0E1A] px-3 py-2 font-mono text-xs text-slate-200 focus:border-[#00D4FF]/60 focus:outline-none"
              >
                {chains.map((c) => (
                  <option key={c.chain} value={c.chain}>
                    {c.label} {c.isTestnet ? '(testnet)' : '(mainnet, real funds)'}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="mb-3 text-sm text-slate-400">
            Send USDC on{' '}
            <span className="font-mono text-slate-200">{selected?.label ?? '—'}</span> to your
            agent wallet:
          </p>

          {/*
            The sharper of the two risks, and the one nothing else on this page
            covers. The mainnet warning below is about sending on the wrong
            chain; this is about sending on the right chain to the other
            wallet, which looks identical and fails just as completely.
          */}
          {hasBothNetworks && (
            <p className="mb-3 flex items-start gap-2 rounded-lg border border-[#1A7FFF]/30 bg-[#1A7FFF]/10 p-2.5 text-xs leading-relaxed text-slate-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#00D4FF]" />
              <span>
                Testnet and mainnet are <strong className="font-semibold">separate wallets at
                different addresses</strong>. Check the network above matches the one you are
                sending from. Funds sent to the other address cannot be moved or recovered from
                here.
              </span>
            </p>
          )}

          {selected && selected.isTestnet === false && (
            <p className="mb-3 flex items-start gap-2 rounded-lg border border-[#FFA040]/40 bg-[#FFA040]/10 p-2.5 text-xs leading-relaxed text-[#FFA040]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong className="font-semibold">{selected.label} is a mainnet.</strong> Funds
                sent here are real. Send on {selected.label}. USDC sent on another EVM network is
                still yours but may not be reachable here; USDC sent on a non-EVM network is lost
                for good.
              </span>
            </p>
          )}

          {address ? (
            <>
              {qr && (
                <div className="mb-4 flex justify-center">
                  <img
                    src={qr}
                    alt={`QR code for the ${selected?.label ?? ''} agent wallet address`}
                    className="h-40 w-40 rounded-lg border border-[#1A7FFF]/25"
                  />
                </div>
              )}

              <div className="flex items-center gap-2 rounded-lg border border-[#1A7FFF]/25 bg-[#0A0E1A] p-3">
                <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-slate-300">
                  {address}
                </code>
                <button
                  onClick={async () => setCopied(await copyToClipboard(address))}
                  className="shrink-0 text-slate-500 transition-colors hover:text-[#00D4FF]"
                  aria-label={`Copy ${selected?.label ?? ''} deposit address`}
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
            /*
              No address, and nothing put in its place. Every alternative here
              is another network's address, which is the failure this panel
              exists to prevent.
            */
            <p className="rounded-lg border border-[#1A7FFF]/25 bg-[#0A0E1A] p-3 text-xs leading-relaxed text-slate-400">
              {/*
                A network only appears in this list once it is enabled, so a
                missing address here means provisioning did not finish rather
                than that the user has not opted in. Saying "enable mainnet"
                would send them to a switch already in the position they need.
              */}
              {selected
                ? `No ${selected.label} wallet on this account yet, so provisioning did not finish. Switch mainnet spending off and back on below to try again.`
                : 'Loading your deposit address.'}
            </p>
          )}

          {selected && selected.isTestnet === false && address && (
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              This is the only mainnet network you need to fund. When a service settles somewhere
              else, the agent moves what that call needs and pays the fee on the far side.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
