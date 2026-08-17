import { ContentPage, Note, Section, type TocEntry } from './ContentPage.tsx'

/**
 * Public documentation.
 *
 * Every figure and every quoted message here is taken from the code rather than
 * from memory: the default cap, the verification amount, the probe states, and
 * the refusal strings the runner actually prints. A number that drifts out of
 * date is a small problem; a security claim that was never true is a different
 * kind, which is why that section says the key does leave the browser.
 */

const TOC: TocEntry[] = [
  { id: 'what', label: 'What Trident is' },
  { id: 'start', label: 'Quickstart' },
  { id: 'concepts', label: 'Core concepts' },
  { id: 'run', label: 'How a run works' },
  { id: 'paying', label: 'Paying for a call' },
  { id: 'wallet', label: 'The wallet' },
  { id: 'limits', label: 'Spending controls' },
  { id: 'catalog', label: 'Endpoints & status' },
  { id: 'security', label: 'Security' },
  { id: 'trouble', label: 'Troubleshooting' },
  { id: 'gaps', label: 'Limits & gaps' },
]

export function DocsPage() {
  return (
    <ContentPage
      eyebrow="Documentation"
      title={
        <>
          Tell your agent
          <br />
          what you want.
        </>
      }
      lede={
        <>
          Trident gives you an agent with its own wallet and a catalog of paid services it
          can buy from. You describe a goal in a sentence; it finds the service, shows you
          the price, and pays for the call once you approve, then comes back with the
          answer.
        </>
      }
      toc={TOC}
    >
      <Section id="what" heading="What Trident is">
        <p className="doc-p">
          There is a growing market of APIs that sell themselves to software rather than to
          people: priced per call, paid in stablecoin, no account or API key to set up.
          Trident is a workspace over that market. You get one agent, one wallet it
          controls, and a catalog of everything it can buy, and you operate all three by
          typing what you want.
        </p>
        <p className="doc-p">
          <strong>What it is not.</strong>
        </p>
        <ul className="doc-ul">
          <li className="doc-li">
            Not a crypto wallet app. The wallet exists so the agent can pay; it is not a
            place to hold or trade assets.
          </li>
          <li className="doc-li">
            Not an exchange or a broker. Trident never swaps, invests or lends anything.
          </li>
          <li className="doc-li">
            Not financial advice. Whatever a service returns is data. What you do with it
            is yours.
          </li>
        </ul>
      </Section>

      <Section id="start" heading="Quickstart">
        <ol className="doc-steps">
          <li className="doc-step">
            <strong>Sign in</strong> with Google or by signing a message with an existing
            wallet. Signing a message proves who you are; it never moves funds and never
            gives Trident access to that wallet.
          </li>
          <li className="doc-step">
            <strong>Set a passphrase.</strong> Trident creates a wallet for your agent and
            stores a check derived from this passphrase. The passphrase is what confirms a
            spend is you; it does not unlock a key, because there is no key on your side to
            unlock. Write it down somewhere safe.{' '}
            <a className="doc-a" href="#security">Security</a> explains exactly where the
            key lives.
          </li>
          <li className="doc-step">
            <strong>Fund the testnet wallet from the faucet.</strong> This comes before your
            first run, not after it. Open Deposit in Wallet, select Arc Testnet, and send
            that address testnet USDC from the{' '}
            <a
              className="doc-a"
              href="https://faucet.circle.com"
              target="_blank"
              rel="noreferrer noopener"
            >
              Circle faucet
            </a>
            . An unfunded wallet cannot complete a single call, free ones included.
          </li>
          <li className="doc-step">
            <strong>Run something from the free tier.</strong> Ask for the weather, or a
            token price. These cost you no real money, but they are not free of mechanics:
            each one settles a testnet transfer, which is what the faucet is for.
          </li>
          <li className="doc-step">
            <strong>Turn on mainnet spending</strong> when you want the paid catalog. It is
            off until you switch it on, so nothing can cost real money before you decide it
            can. Enabling it creates a second wallet, on mainnet, at a different address.
          </li>
          <li className="doc-step">
            <strong>Fund that mainnet wallet</strong> from the same Deposit panel, with the
            network switched to mainnet. Check the address each time: the two wallets are
            separate and a deposit to the wrong one cannot be recovered from Trident.
          </li>
        </ol>
        <Note tag="The free tier is not a simulation" tone="free">
          <p>
            Every free call still settles a real transfer on Arc testnet, one millionth of
            a dollar, <code className="font-mono text-[#00D4FF]">0.000001 USDC</code>. That
            is why funding comes first: the meter is what stops an empty wallet from calling
            anything, and it is the same payment path that will later move real money. By
            the time you fund anything on mainnet, you have already done it once.
          </p>
        </Note>
      </Section>

      <Section id="concepts" heading="Core concepts">
        <div className="doc-scroll">
          <table className="doc-table">
            <thead>
              <tr>
                <th>Term</th>
                <th>What it means here</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="k">Agent</td>
                <td>
                  The thing that reads your goal, picks a service, pays and answers. One per
                  account.
                </td>
              </tr>
              <tr>
                <td className="k">Agent wallet</td>
                <td>
                  A wallet Trident creates for your agent through Circle, which holds the
                  signing key. Your passphrase gates spending from it. Two of them once you
                  enable mainnet, one per network, at different addresses.
                </td>
              </tr>
              <tr>
                <td className="k">Catalog</td>
                <td>
                  Every service the agent can buy from, synced from Circle&apos;s marketplace
                  and checked for reachability.
                </td>
              </tr>
              <tr>
                <td className="k">Plan</td>
                <td>
                  The steps the agent proposes, each with a named service and a price, before
                  anything is spent.
                </td>
              </tr>
              <tr>
                <td className="k">Spending cap</td>
                <td>
                  An absolute ceiling you set. The agent cannot exceed it, and never raises it
                  for you.
                </td>
              </tr>
              <tr>
                <td className="k">Rail</td>
                <td>
                  How a payment settles. Trident speaks two, and picks per service. You never
                  choose.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="run" heading="How a run works">
        <ol className="doc-steps">
          <li className="doc-step">
            <strong>You type a goal.</strong> Plain language, one sentence.
          </li>
          <li className="doc-step">
            <strong>Trident shortlists services</strong> from the catalog that match what you
            asked for.
          </li>
          <li className="doc-step">
            <strong>A plan comes back priced.</strong> Each step names the service, what it is
            for, and what it costs.
          </li>
          <li className="doc-step">
            <strong>You approve it.</strong> Nothing is paid before this. You can drop steps,
            set a budget for this run, or cancel.
          </li>
          <li className="doc-step">
            <strong>The agent pays and calls,</strong> step by step, streaming progress as it
            goes.
          </li>
          <li className="doc-step">
            <strong>You get an answer</strong> in prose, with the receipts underneath.
          </li>
        </ol>

        <h3 className="doc-h3">What stops a run before it costs anything</h3>
        <p className="doc-p">
          Most failures are caught before money moves, not after. Every refusal below happens
          pre-payment and says so.
        </p>
        <ul className="doc-ul">
          <li className="doc-li">
            <strong>A required detail is missing.</strong> The call cannot be formed, so it is
            not attempted.
          </li>
          <li className="doc-li">
            <strong>The address needs a value you did not give,</strong> such as a stock symbol
            or a coin id. You are asked for it on the approval card before you approve.
          </li>
          <li className="doc-li">
            <strong>The live price is above what you approved.</strong> Prices are re-read
            from the seller at the moment of the call, not taken from the catalog, so a
            service that quietly got more expensive stops the run instead of quietly spending
            more.
          </li>
          <li className="doc-li">
            <strong>The service only settles on a live network,</strong> and mainnet spending
            is switched off. That is a single setting in Wallet rather than a per-network
            one: turning it on opens every live network the agent can pay through.
          </li>
        </ul>
      </Section>

      <Section id="paying" heading="Paying for a call">
        <p className="doc-p">
          A paid service answers an unpaid request with{' '}
          <code className="font-mono text-[#00D4FF]">402 Payment Required</code> and its
          terms. Trident signs an authorisation for exactly that amount, and the service
          answers. You are not asked to confirm anything at this point, because you already
          approved the plan and its price.
        </p>

        <h3 className="doc-h3">Both paid rails are signature-only</h3>
        <Note tag="No gas token, ever">
          <p>
            You never buy ETH, MATIC or anything else to make a payment work. Your wallet
            signs; someone else submits the transaction and pays the network fee. USDC is the
            only thing you need to hold.
          </p>
        </Note>

        <div className="doc-scroll">
          <table className="doc-table">
            <thead>
              <tr>
                <th>Rail</th>
                <th>What is signed</th>
                <th>Which balance pays</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="k">Circle Gateway</td>
                <td>An authorisation against Circle&apos;s Gateway contract</td>
                <td>Your Gateway balance</td>
              </tr>
              <tr>
                <td className="k">Plain x402</td>
                <td>An authorisation against the USDC token itself</td>
                <td>Your wallet balance</td>
              </tr>
              <tr>
                <td className="k">Free tier</td>
                <td>A tiny transfer on Arc testnet</td>
                <td>Testnet USDC</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="doc-h3">When the seller wants a different network</h3>
        <p className="doc-p">
          A service may price itself on Polygon while your money sits on Base. Trident moves
          it: the USDC is burned on your chain, Circle attests the burn, and it is minted on
          the seller&apos;s chain and credited to you. Trident pays the destination network
          fee so you do not need funds on a chain you have never used.
        </p>
      </Section>

      <Section id="wallet" heading="The wallet">
        <p className="doc-p">
          Your agent&apos;s money sits in one of two places, and the difference matters
          because different rails draw on different ones.
        </p>
        <ul className="doc-ul">
          <li className="doc-li">
            <strong>Wallet balance:</strong> plain USDC held by your agent&apos;s address.
            Pays plain x402 services, and is what you withdraw from.
          </li>
          <li className="doc-li">
            <strong>Gateway balance:</strong> USDC you have deposited into Circle&apos;s
            Gateway. Pays Gateway services. Held per network.
          </li>
        </ul>
        <p className="doc-p">
          Moving between them is instant and stays inside your own address. Deposit into
          Gateway when you want to buy from Gateway services; pull back out when you want to
          withdraw.
        </p>
        <Note tag="Sending funds in" tone="money">
          <p>
            Send USDC on the network Wallet is showing. That is the one the agent will spend
            from, and the one a deposit appears on straight away.
          </p>
          <p className="mt-2">
            If you send on a different EVM network, the money is still yours. Your
            agent&apos;s address is an ordinary wallet address, and the same key controls it
            on every EVM chain, so nothing is destroyed by arriving in the wrong place.
            Trident may simply not be able to show or spend it until that network is the one
            selected. If you land in that situation,{' '}
            <a
              className="doc-a"
              href="https://x.com/tridentagent"
              target="_blank"
              rel="noreferrer noopener"
            >
              ask us on X
            </a>{' '}
            and we will tell you where it is.
          </p>
          <p className="mt-2">
            The exception is a non-EVM network such as Solana or Tron. Those use a different
            address format entirely, so USDC sent that way does not reach your wallet and
            cannot be recovered.
          </p>
        </Note>
      </Section>

      <Section id="limits" heading="Spending controls">
        <ul className="doc-ul">
          <li className="doc-li">
            <strong>A spending cap</strong>, set by you and absolute. It starts at{' '}
            <code className="font-mono text-[#00D4FF]">$10.00</code>. The agent will stop a
            run rather than cross it, and will never raise it on your behalf.
          </li>
          <li className="doc-li">
            <strong>A per-run budget</strong>, optional, set on the approval card when you
            want this one task kept smaller than the cap.
          </li>
          <li className="doc-li">
            <strong>Mainnet off by default.</strong> Until you switch it on, the agent can
            only spend testnet funds, so no goal can cost real money by accident.
          </li>
          <li className="doc-li">
            <strong>Every price shown before approval</strong>, priced from the catalog and
            then re-checked against the seller at the moment of the call.
          </li>
        </ul>
        <p className="doc-p">
          If a run stops at the cap, the steps already completed stay paid for and their
          results are kept. Retrying resumes from where it stopped rather than paying again
          for work already delivered.
        </p>
      </Section>

      <Section id="catalog" heading="Endpoints and status">
        <p className="doc-p">
          Every service in the catalog is probed continuously, and{' '}
          <a
            className="doc-a"
            href="https://status.tridentagent.xyz"
            target="_blank"
            rel="noreferrer noopener"
          >
            status.tridentagent.xyz
          </a>{' '}
          shows what each one is doing right now. The probe is an unpaid request, so checking
          costs nothing and charges no one.
        </p>
        <div className="doc-scroll">
          <table className="doc-table">
            <thead>
              <tr>
                <th>State</th>
                <th>What it tells you</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="k">
                  <span className="badge bg-[#00FF88]/10 text-[#00FF88]">live</span>
                </td>
                <td>
                  Answered with its payment terms. Up, and still selling at a known price.
                </td>
              </tr>
              <tr>
                <td className="k">
                  <span className="badge bg-[#FFA040]/10 text-[#FFA040]">answering</span>
                </td>
                <td>
                  Answered, but not with terms we could confirm. The host is up and the path
                  exists; whether it will sell is unproven.
                </td>
              </tr>
              <tr>
                <td className="k">
                  <span className="badge bg-[#FF4466]/10 text-[#FF4466]">gone</span>
                </td>
                <td>The path is not there. Nothing to buy.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="doc-p">
          A service is only withheld from the agent after it fails twice in a row, and it
          returns the moment it answers again. Being listed is not a promise it will work. It
          is a report of what it did when last asked.
        </p>
      </Section>

      <Section id="security" heading="Security">
        <Note tag="Read this one" tone="stop">
          <p>
            <strong>Trident can spend from your agent&apos;s wallet.</strong> That is what makes
            an agent able to pay for things while you are not watching, and it is the trade you
            are making. Your spending cap is the limit, and it is enforced on every call.
          </p>
        </Note>

        <h3 className="doc-h3">Where the signing key lives, precisely</h3>
        <p className="doc-p">
          Your agent&apos;s wallet is created and held by Circle. The key that signs from it is
          generated inside Circle&apos;s infrastructure and never exists on your device or on
          ours.
        </p>
        <ul className="doc-ul">
          <li className="doc-li">
            <strong>Nothing we send or receive contains a key.</strong> A payment is a signature
            Circle produces on our request, and a transfer is a transaction Circle submits.
          </li>
          <li className="doc-li">
            <strong>This is custody, not self-custody.</strong> There is no key for you to export
            or to import into another wallet. To hold your own keys, withdraw to a wallet you
            control.
          </li>
          <li className="doc-li">
            <strong>Your passphrase confirms it is you.</strong> It is checked in your browser
            against a value that opens nothing, and it gates spending rather than unlocking a
            key. We never store the passphrase itself.
          </li>
          <li className="doc-li">
            <strong>Your other wallet is untouched.</strong> Signing in with a wallet produces
            a signature, nothing more. Trident cannot move anything in it.
          </li>
        </ul>
        <p className="doc-p">
          This replaced an earlier design where the wallet key was encrypted with your passphrase
          and sent to our server on every payment. That is worth stating rather than quietly
          changing: the old arrangement was self-custody but put the key on the network
          constantly, and the new one keeps the key off the network entirely but puts Trident in
          a position to spend. Neither is free of risk; they are different risks.
        </p>

        <h3 className="doc-h3">Two wallets, once mainnet is on</h3>
        <p className="doc-p">
          Circle keeps sandbox and production entirely separate, and a wallet in one cannot be
          reached from the other. So an account with mainnet enabled has two agent wallets at
          two different addresses, one per network. Deposit shows the address for whichever
          network you select there, and only that one. USDC sent to the other address is not
          recoverable through Trident.
        </p>

        <h3 className="doc-h3">Staying unlocked</h3>
        <p className="doc-p">
          Once you confirm your passphrase, the agent can keep spending up to your cap without
          asking again. There is no idle timeout. Closing or refreshing the tab clears it. On a
          shared or unattended machine, close the tab.
        </p>
      </Section>

      <Section id="trouble" heading="Troubleshooting">
        <h3 className="doc-h3-quote">
          &ldquo;…needs <em className="not-italic text-[#00D4FF]">x</em> to answer this.
          Nothing was charged.&rdquo;
        </h3>
        <p className="doc-p">
          The service requires a detail your goal did not contain. Say it explicitly, naming
          the city, the token or the address, and run again. No payment was made.
        </p>

        <h3 className="doc-h3">The approval card is asking for a value</h3>
        <p className="doc-p">
          Some services put a value in their address rather than taking it as a parameter: a
          stock symbol, a coin id, a wallet. If your goal did not say which, the agent asks
          instead of guessing. Fill it in and Approve unlocks.
        </p>

        <h3 className="doc-h3-quote">
          &ldquo;This service settles on mainnet. Enable mainnet spending in Wallet to use
          it.&rdquo;
        </h3>
        <p className="doc-p">
          The plan picked a paid service while your account is still testnet-only. Turn on
          mainnet spending in Wallet, or ask for something the free tier covers.
        </p>

        <h3 className="doc-h3">The run stopped and mentioned the cap</h3>
        <p className="doc-p">
          The next call&apos;s live price would have taken the run past your ceiling. Nothing
          beyond that point was paid. Raise the cap, or lower the scope of the goal.
        </p>

        <h3 className="doc-h3">A service is red on the status page</h3>
        <p className="doc-p">
          It is not answering. The agent will route around it where an alternative exists;
          where none does, the goal cannot be met right now.
        </p>

        <h3 className="doc-h3">Signed out unexpectedly</h3>
        <p className="doc-p">
          Your session lives in the browser. Clearing site data signs you out. It does not
          affect your wallet or its funds, which are on-chain and reachable with your
          passphrase.
        </p>
      </Section>

      <Section id="gaps" heading="Limits and known gaps">
        <p className="doc-p">
          Trident is a v1. These are true today and worth knowing before you rely on it.
        </p>
        <ul className="doc-ul">
          <li className="doc-li">
            <strong>Payments are irreversible.</strong> Once a call is paid for, the money is
            spent, including when the answer turns out to be useless.
          </li>
          <li className="doc-li">
            <strong>We do not control the sellers.</strong> Accuracy, uptime and content are
            theirs. Trident reports what it can observe and does not vouch for what comes
            back.
          </li>
          <li className="doc-li">
            <strong>A goal can be unmeetable.</strong> If nothing in the catalog fits, the
            agent says so rather than substituting something unrelated.
          </li>
          <li className="doc-li">
            <strong>The catalog moves.</strong> Services appear, change price and disappear
            without notice; prices are re-read at call time for exactly this reason.
          </li>
          <li className="doc-li">
            <strong>No idle lock.</strong> See <a className="doc-a" href="#security">Security</a>.
          </li>
        </ul>
      </Section>
    </ContentPage>
  )
}
