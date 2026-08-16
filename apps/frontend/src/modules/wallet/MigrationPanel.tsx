import { useCallback, useEffect, useState } from 'react'
import { createWalletClient, createPublicClient, http, erc20Abi, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AlertTriangle, Check, Clipboard, Download, Eye, Loader2 } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { copyToClipboard } from '../../lib/format.ts'
import { useAgentStore } from '../../store/agentStore.ts'
import { useWalletStore } from '../../store/walletStore.ts'

/**
 * Moving this account onto a Circle wallet, once.
 *
 * The old address's funds can only be released by the old key, and that key
 * never leaves this browser: the Gateway balance is released by signing an
 * intent the server composed, and the plain USDC by a transfer signed here and
 * sent straight to an RPC. The server relays and pays gas but never holds the
 * key, which is the whole point of the exercise.
 *
 * Every step re-reads what is actually left rather than trusting a remembered
 * figure, because the failure mode of getting that wrong is money stranded at
 * an address nobody can sign for any more.
 */

type Status = Awaited<ReturnType<typeof api.migrationStatus>>

export function MigrationPanel() {
  const requestUnlock = useAgentStore((s) => s.requestUnlock)
  const refreshAll = useWalletStore((s) => s.refreshAll)

  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const [exportedKey, setExportedKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await api.migrationStatus())
    } catch {
      /* An account with no wallet at all simply has nothing to migrate. */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!status?.oldAddress || status.state === 'complete') return null

  const remainingGateway = Number(status.remaining.gatewayUsdc)
  const gatewayChains = status.remaining.gatewayByChain ?? []
  const remainingWallet = status.remaining.walletByChain
  const testnetLeft = status.testnetRemaining ?? []
  /*
   * Only real money holds this up. Testnet balances are shown so the choice to
   * leave them is a choice rather than an oversight, but they cannot block:
   * refusing to finish over play money would strand the account half migrated,
   * which is the one genuinely risky state in this whole flow.
   */
  const nothingLeft = remainingGateway <= 0 && remainingWallet.length === 0

  async function withKey(label: string, fn: (key: string) => Promise<void>) {
    const key = useAgentStore.getState().unlockedKey
    if (!key) {
      requestUnlock(() => void withKey(label, fn))
      return
    }
    setBusy(label)
    setMessage(null)
    try {
      await fn(key)
      await load()
      void refreshAll()
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'That step failed' })
    } finally {
      setBusy(null)
    }
  }

  /** Step 1. Safe to repeat: the server returns the existing wallet. */
  async function provision() {
    setBusy('provision')
    setMessage(null)
    try {
      const res = await api.migrateProvision()
      /*
       * Two environments means up to two wallets. Report what was actually made
       * and, more importantly, what could not be: a user told "done" who has no
       * mainnet wallet would discover it at their first real payment.
       */
      const made = res.created.length > 0 ? `Created: ${res.created.join(' and ')}.` : 'Already created.'
      const gap =
        res.missing.length > 0
          ? ` ${res.missing.join(' and ')} is not configured yet, so that side cannot be set up.`
          : ''
      setMessage({ tone: res.missing.length > 0 ? 'err' : 'ok', text: made + gap })
      await load()
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not create it' })
    } finally {
      setBusy(null)
    }
  }

  /**
   * Step 2. The Gateway ledger, released with a signature and nothing else.
   *
   * The intent comes from the server already addressed to the new wallet, so
   * what is signed here cannot be redirected.
   */
  async function moveGateway(chain: string, amountUsdc: string) {
    await withKey(`gateway:${chain}`, async (key) => {
      const account = privateKeyToAccount(key as `0x${string}`)

      const attempt = async (amount: string) => {
        const { typedData } = await api.migrateGatewayIntent(chain, amount)
        const signature = await account.signTypedData(
          typedData as Parameters<typeof account.signTypedData>[0],
        )
        return { res: await api.migrateGatewayTransfer(signature), amount }
      }

      /*
       * One automatic retry, because moving the whole balance cannot work.
       *
       * Circle takes its fee from the same ledger, so it needs value plus fee
       * and only value is there. The fee is published nowhere, differs by
       * chain, and the rejection states it exactly, so the server reads it back
       * and names the movable amount. Retrying with that empties the balance,
       * which is what finishing requires. Each attempt is signed separately:
       * a different amount is a different digest.
       */
      let out: Awaited<ReturnType<typeof attempt>>
      try {
        out = await attempt(amountUsdc)
      } catch (err) {
        const movable = (err as { details?: Record<string, unknown> })?.details?.['movableUsdc']
        if (typeof movable !== 'string') throw err
        out = await attempt(movable)
      }

      setMessage({
        tone: 'ok',
        text: `Moved ${out.amount} USDC out of Gateway on ${chain}. Mint ${out.res.mintTxHash.slice(0, 14)}…`,
      })
    })
  }

  /** Step 3. Plain USDC, signed and sent from this browser. */
  async function sweepChain(chain: string) {
    await withKey(`sweep:${chain}`, async (key) => {
      const info = await api.migrateOldBalance(chain)
      if (!info.newAddress) throw new Error('Create the new wallet first.')
      if (BigInt(info.usdcAtomic) <= 0n) throw new Error('Nothing left to move on this network.')
      if (BigInt(info.nativeWei) === 0n) {
        throw new Error(
          `The old address has no ${chain} gas, so it cannot send. Send a small amount of the ` +
            'network token to it and try again.',
        )
      }

      const account = privateKeyToAccount(key as `0x${string}`)
      // Minimal chain definition: only the id and an RPC are needed to send,
      // and both come from the server so they cannot drift from what it reads.
      const chainDef = defineChain({
        id: info.chainId,
        name: chain,
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
        rpcUrls: { default: { http: [info.rpcUrl] } },
      })
      const transport = http(info.rpcUrl)
      const wallet = createWalletClient({ account, chain: chainDef, transport })
      const publicClient = createPublicClient({ chain: chainDef, transport })

      const hash = await wallet.writeContract({
        address: info.usdcAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [info.newAddress as `0x${string}`, BigInt(info.usdcAtomic)],
      })
      // A receipt is not success: this resolves for a reverted transaction too.
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`The transfer reverted (${hash}).`)

      setMessage({ tone: 'ok', text: `Moved ${info.usdc} USDC from ${chain}.` })
    })
  }

  /** Step 4. Take a copy of the key being retired, before it is deleted. */
  async function exportKey() {
    await withKey('export', async (key) => {
      setExportedKey(key)
      setRevealed(false)
    })
  }

  /** Step 5. The server checks the old address is empty before deleting. */
  async function finish() {
    setBusy('complete')
    setMessage(null)
    try {
      await api.migrateComplete()
      setMessage({ tone: 'ok', text: 'Migration finished.' })
      await load()
    } catch (err) {
      setMessage({ tone: 'err', text: err instanceof Error ? err.message : 'Could not finish' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel border-[#FFA040]/40 p-5 lg:col-span-2">
      <h2 className="heading-mono mb-4 text-[#FFA040]">Move to your new wallet</h2>

      <p className="mb-4 text-sm leading-relaxed text-slate-400">
        Your agent is moving to a wallet Circle signs for, so your private key stops being sent
        over the network every time you pay for something. Your funds move with it, and you get to
        keep the original key.
      </p>

      <ol className="mb-5 flex flex-col gap-4">
        <Step n={1} done={Boolean(status.newAddress)} title="Create the new wallet">
          {status.newAddress ? (
            <code className="break-all font-mono text-[11px] text-slate-400">
              {status.newAddress}
            </code>
          ) : (
            <button className="btn-primary" onClick={provision} disabled={busy !== null}>
              {busy === 'provision' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create it
            </button>
          )}
        </Step>

        <Step n={2} done={remainingGateway <= 0} title="Move the Gateway balance">
          {/*
            One row per chain. A Gateway balance is a ledger per network, not a
            single pot, so a button offering the total against one chain asks
            for more than that chain holds and is refused.
          */}
          {gatewayChains.length > 0 ? (
            <div className="flex flex-col gap-2">
              {gatewayChains.map((b) => (
                <div key={b.chain} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-300">{b.chain}</span>
                  <span className="text-xs text-slate-400">{b.usdc} USDC</span>
                  <button
                    className="btn-ghost"
                    disabled={busy !== null || !status!.newAddress}
                    onClick={() => void moveGateway(b.chain, b.usdc)}
                  >
                    {busy === `gateway:${b.chain}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Move it
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-500">Nothing in Gateway.</span>
          )}
        </Step>

        <Step n={3} done={remainingWallet.length === 0} title="Move the remaining USDC">
          {remainingWallet.length > 0 ? (
            <div className="flex flex-col gap-2">
              {remainingWallet.map((b) => (
                <div key={b.chain} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-300">{b.chain}</span>
                  <span className="text-xs text-slate-400">{b.usdc} USDC</span>
                  <button
                    className="btn-ghost"
                    disabled={busy !== null || !status!.newAddress}
                    onClick={() => void sweepChain(b.chain)}
                  >
                    {busy === `sweep:${b.chain}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Move it
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-500">Nothing left at the old address.</span>
          )}
        </Step>

        <Step n={4} done={acknowledged} title="Keep your original key">
          <KeyKeepsake
            address={status.oldAddress}
            exportedKey={exportedKey}
            revealed={revealed}
            copied={copied}
            acknowledged={acknowledged}
            busy={busy === 'export'}
            onExport={() => void exportKey()}
            onReveal={() => setRevealed(true)}
            onCopy={async () => setCopied(await copyToClipboard(exportedKey ?? ''))}
            onAcknowledge={() => setAcknowledged(true)}
          />
        </Step>

        <Step n={5} done={false} title="Finish">
          <button
            className="btn-primary"
            disabled={busy !== null || !nothingLeft || !acknowledged || !status.hasVerifier}
            onClick={finish}
          >
            {busy === 'complete' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Finish and delete the old key
          </button>
          {!status.hasVerifier && (
            <p className="mt-2 text-[11px] text-[#FFA040]">
              Unlock your wallet once first, so your passphrase keeps working afterwards.
            </p>
          )}
          {testnetLeft.length > 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Leaving {testnetLeft.map((b) => `${b.usdc} on ${b.chain}`).join(', ')} behind. Testnet
              funds are not real and do not hold this up. Your original key still reaches them.
            </p>
          )}
        </Step>
      </ol>

      {message && (
        <p
          className={`break-words text-xs ${message.tone === 'ok' ? 'text-[#00FF88]' : 'text-[#FF4466]'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number
  done: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
          done ? 'bg-[#00FF88]/15 text-[#00FF88]' : 'bg-[#1A7FFF]/15 text-slate-400'
        }`}
      >
        {done ? <Check className="h-3 w-3" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-sm text-slate-200">{title}</p>
        {children}
      </div>
    </li>
  )
}

/**
 * The old key, handed back to the person it belongs to.
 *
 * Concealed until asked for, never on screen by default, and never sent
 * anywhere: it is already in this browser's memory and goes no further. After
 * the final step it exists nowhere else, which is why finishing is gated on the
 * user saying they have it.
 */
function KeyKeepsake({
  address,
  exportedKey,
  revealed,
  copied,
  acknowledged,
  busy,
  onExport,
  onReveal,
  onCopy,
  onAcknowledge,
}: {
  address: string
  exportedKey: string | null
  revealed: boolean
  copied: boolean
  acknowledged: boolean
  busy: boolean
  onExport: () => void
  onReveal: () => void
  onCopy: () => void
  onAcknowledge: () => void
}) {
  if (!exportedKey) {
    return (
      <div>
        <p className="mb-2 text-xs leading-relaxed text-slate-400">
          This wallet was yours from the start, and we are about to stop holding anything that can
          open it. Take the key first.
        </p>
        <button className="btn-ghost" onClick={onExport} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Show me my key
        </button>
      </div>
    )
  }

  const filename = `trident-wallet-${address.slice(0, 10)}.txt`
  const contents = [
    'Trident agent wallet, original key',
    `address: ${address}`,
    `private key: ${exportedKey}`,
    '',
    'Anyone with this key controls that address, forever.',
    'It is not the key to your new wallet and cannot be used as one.',
  ].join('\n')

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 rounded-lg border border-[#FFA040]/40 bg-[#FFA040]/10 p-2.5 text-xs leading-relaxed text-[#FFA040]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Anyone holding this key controls <span className="font-mono">{address.slice(0, 10)}…</span>{' '}
          forever. It is not your new wallet&apos;s key. Once you finish below, this is the only
          copy that exists.
        </span>
      </p>

      {revealed ? (
        <div className="flex items-center gap-2 rounded-lg border border-[#1A7FFF]/25 bg-[#0A0E1A] p-3">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-slate-300">
            {exportedKey}
          </code>
          <button
            onClick={onCopy}
            className="shrink-0 text-slate-500 transition-colors hover:text-[#00D4FF]"
            aria-label="Copy private key"
          >
            {copied ? (
              <Check className="h-4 w-4 text-[#00FF88]" />
            ) : (
              <Clipboard className="h-4 w-4" />
            )}
          </button>
        </div>
      ) : (
        <button className="btn-ghost" onClick={onReveal}>
          <Eye className="h-4 w-4" />
          Reveal it
        </button>
      )}

      <a
        className="btn-ghost"
        download={filename}
        href={`data:text/plain;charset=utf-8,${encodeURIComponent(contents)}`}
      >
        <Download className="h-4 w-4" />
        Download as a file
      </a>

      {!acknowledged && (
        <button className="btn-ghost" onClick={onAcknowledge}>
          I have saved it
        </button>
      )}
    </div>
  )
}
