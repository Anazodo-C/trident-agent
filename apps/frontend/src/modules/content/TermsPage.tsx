import { ContentPage, Note, Section, type TocEntry } from './ContentPage.tsx'

/**
 * Terms of service.
 *
 * Clause 1 states the whole risk surface before any legal furniture, because
 * three facts do most of the work here and burying them at clause 12 would be a
 * choice about whether anyone reads them: the passphrase cannot be recovered,
 * payments cannot be reversed, and the services are not ours.
 *
 * The keeper key in clause 6 is described rather than glossed over. It is the
 * one place Trident signs anything, and a reader is entitled to know what it
 * can and cannot do with their money.
 */

const TOC: TocEntry[] = [
  { id: 'three', label: 'Three things first' },
  { id: 'agree', label: 'Agreement' },
  { id: 'what', label: 'What Trident does' },
  { id: 'account', label: 'Account and passphrase' },
  { id: 'wallet', label: 'The agent wallet' },
  { id: 'keeper', label: 'Cross-chain settlement' },
  { id: 'payments', label: 'Payments' },
  { id: 'controls', label: 'Spending controls' },
  { id: 'third', label: 'Third-party services' },
  { id: 'noadvice', label: 'Not advice' },
  { id: 'use', label: 'Acceptable use' },
  { id: 'asis', label: 'No warranty' },
  { id: 'liability', label: 'Liability' },
  { id: 'ending', label: 'Ending it' },
  { id: 'changes', label: 'Changes' },
  { id: 'law', label: 'General' },
]

export function TermsPage() {
  return (
    <ContentPage
      eyebrow="Terms of Service"
      title={
        <>
          What you are
          <br />
          agreeing to.
        </>
      }
      lede={
        <>
          Trident lets software spend your money on your instruction. That makes a few things
          matter more than they would elsewhere: the passphrase cannot be reset, payments
          cannot be reversed, and the services being bought from are not ours. Those three are
          stated first, in plain words, before the rest.
        </>
      }
      updated="12 August 2026"
      toc={TOC}
      numbered
    >
      <Section id="three" heading="Three things first" numbered>
        <Note tag="Your passphrase cannot be recovered" tone="stop">
          <p>
            It is the only thing that decrypts your agent&apos;s wallet. We do not have it and
            cannot reset it. If you lose it, the money in that wallet is gone permanently. Not
            withheld, not recoverable through support, gone.
          </p>
        </Note>
        <Note tag="Payments cannot be undone" tone="money">
          <p>
            Once your agent pays for a call, the money has moved. There is no chargeback and
            no refund, including when the answer is wrong, useless, or not what you hoped for.
          </p>
        </Note>
        <Note tag="The services are not ours">
          <p>
            Trident finds and pays third-party providers. We do not write, host, verify or
            control what they return, and we do not guarantee they are accurate, available, or
            fit for anything you have in mind.
          </p>
        </Note>
      </Section>

      <Section id="agree" heading="Agreement" numbered>
        <ol className="doc-sub">
          <li>By using Trident you accept these terms. If you do not, do not use it.</li>
          <li>You must be at least 18 and legally able to enter a contract.</li>
          <li>
            You must not be located in, or acting for anyone in, a country subject to
            comprehensive sanctions, and you must not appear on any applicable sanctions list.
          </li>
          <li>
            You are responsible for whether using a service like this is lawful where you are.
          </li>
        </ol>
      </Section>

      <Section id="what" heading="What Trident does" numbered>
        <ol className="doc-sub">
          <li>
            Trident is software that reads a goal you type, searches a catalog of paid APIs,
            proposes a plan with prices, and, after you approve it, pays for those calls from a
            wallet you control and returns the results.
          </li>
          <li>
            Trident is not a bank, an exchange, a broker, a custodian, or a money transmitter.
            It does not hold, invest, lend or convert your funds, and it takes no fee or spread
            on what you spend.
          </li>
          <li>
            Trident is version 1 software under active development. Features change, and some
            of them will change without notice.
          </li>
        </ol>
      </Section>

      <Section id="account" heading="Account and passphrase" numbered>
        <ol className="doc-sub">
          <li>
            You sign in with Google or by signing a message with a wallet you already control.
            Signing that message proves identity only; it gives Trident no ability to move
            anything in that wallet.
          </li>
          <li>
            You choose a passphrase. It encrypts your agent&apos;s wallet key, and it never
            reaches us in a form we retain.
          </li>
          <li>
            <strong>Keep it safe and keep a copy somewhere separate.</strong> We cannot reset
            it, email it, or work around it. See clause 1.
          </li>
          <li>
            Anyone with your passphrase and access to your signed-in browser can spend up to
            your cap. Once unlocked, a session stays unlocked until the tab is closed or
            refreshed, so close the tab on a shared or unattended machine.
          </li>
          <li>You are responsible for activity under your account.</li>
        </ol>
      </Section>

      <Section id="wallet" heading="The agent wallet" numbered>
        <ol className="doc-sub">
          <li>
            When you set a passphrase, Trident generates a new wallet for your agent and
            encrypts its key with a key derived from that passphrase.
          </li>
          <li>
            We store that encrypted key. <strong>We cannot decrypt it</strong>, because we do
            not have your passphrase, and we cannot move your funds.
          </li>
          <li>
            To make a payment, the key is decrypted in your browser and sent to our server over
            an encrypted connection to sign that transaction. It is used in memory for that
            operation and never stored in readable form.
          </li>
          <li>
            The funds in that wallet are yours. You can withdraw them to any address at any
            time, and nothing in these terms gives us a claim over them.
          </li>
        </ol>
        <p className="doc-plainly">
          <strong>Plainly:</strong> we hold a locked box we cannot open. You hold the only key,
          and if you lose it the box stays shut forever.
        </p>
      </Section>

      <Section id="keeper" heading="Cross-chain settlement" numbered>
        <ol className="doc-sub">
          <li>
            When a service prices itself on a network your funds are not on, Trident moves the
            funds: they are burned on your network and minted on the seller&apos;s.
          </li>
          <li>
            The second half of that needs a transaction fee on a network where you hold no gas
            token, so <strong>Trident submits it and pays that fee</strong> using a key we
            operate.
          </li>
          <li>
            That key can only deliver the transfer to a contract derived from your own account,
            which can do exactly two things: credit your balance, or refund you. It cannot
            redirect your funds anywhere else, and it never holds them.
          </li>
          <li>
            Cross-chain transfers depend on Circle&apos;s infrastructure and on the networks
            involved. Delays and failures outside our control are possible; where a transfer
            fails, the funds remain recoverable by you.
          </li>
        </ol>
      </Section>

      <Section id="payments" heading="Payments" numbered>
        <ol className="doc-sub">
          <li>
            Prices are set by the service you are buying from, not by us. Trident shows the
            catalog price before you approve, then re-reads the live price at the moment of the
            call and stops rather than paying more than you approved.
          </li>
          <li>
            <strong>Payments are final.</strong> Blockchain transactions cannot be reversed by
            us, by you, or by anyone.
          </li>
          <li>
            <strong>There are no refunds</strong>, including where a service returns an error
            after payment, returns something unhelpful, or goes offline mid-run.
          </li>
          <li>
            Trident charges you nothing. You pay the services, and you pay whatever the
            underlying networks charge.
          </li>
          <li>
            Free-tier calls settle a token amount on a test network. They cost nothing of
            value, and test-network funds have no monetary worth.
          </li>
          <li>You are responsible for any tax arising from your use of the service.</li>
        </ol>
      </Section>

      <Section id="controls" heading="Spending controls" numbered>
        <ol className="doc-sub">
          <li>
            You set a spending cap. It is absolute: the agent stops a run rather than exceeding
            it, and never raises it on your behalf.
          </li>
          <li>Spending on live networks is off until you switch it on.</li>
          <li>
            Every plan is priced and shown to you before anything is paid, and nothing runs
            without your approval.
          </li>
          <li>
            These controls are provided in good faith and work as described, but they are
            software. They are not a guarantee against loss, and clause 13 applies.
          </li>
        </ol>
      </Section>

      <Section id="third" heading="Third-party services" numbered>
        <ol className="doc-sub">
          <li>
            The services in the catalog are operated by other companies. Your use of one is
            between you and them, on whatever terms they impose.
          </li>
          <li>
            We do not verify, endorse or take responsibility for what any of them returns: its
            accuracy, legality, or fitness for your purpose.
          </li>
          <li>
            The status page reports what a service did when it was last checked. It is
            information, not a promise that the service will work when you use it.
          </li>
          <li>
            A service may change its price, its behaviour, or disappear entirely, at any time
            and without telling us.
          </li>
        </ol>
      </Section>

      <Section id="noadvice" heading="Not advice" numbered>
        <ol className="doc-sub">
          <li>
            Nothing Trident returns is financial, investment, legal, tax or professional
            advice. It is data retrieved from a third party, and any summary of it is generated
            automatically.
          </li>
          <li>
            Automated summaries can be wrong or incomplete. Check anything that matters against
            the underlying result.
          </li>
          <li>Decisions you make on the strength of what Trident returns are yours alone.</li>
        </ol>
      </Section>

      <Section id="use" heading="Acceptable use" numbered>
        <p className="doc-p">You agree not to:</p>
        <ul className="doc-ul">
          <li className="doc-li">break the law, or use Trident to help anyone else do so;</li>
          <li className="doc-li">
            use the agent to overload, attack, scrape abusively, or otherwise interfere with
            any service in the catalog;
          </li>
          <li className="doc-li">
            work around spending caps, approval steps, or any other control in the product;
          </li>
          <li className="doc-li">
            put credentials, private keys, or other people&apos;s personal information into a
            goal;
          </li>
          <li className="doc-li">
            attempt to access another user&apos;s account, wallet, or run history;
          </li>
          <li className="doc-li">launder money, evade sanctions, or fund anything unlawful;</li>
          <li className="doc-li">
            resell or redistribute a service&apos;s output in breach of that service&apos;s own
            terms.
          </li>
        </ul>
        <p className="doc-p">We may suspend or remove an account that does any of this.</p>
      </Section>

      <Section id="asis" heading="No warranty" numbered>
        <ol className="doc-sub">
          <li>
            Trident is provided <strong>as is</strong> and <strong>as available</strong>, with
            no warranty of any kind, express or implied, including merchantability, fitness for
            a particular purpose, and non-infringement.
          </li>
          <li>
            We do not warrant that it will be uninterrupted, timely, secure, or error-free, or
            that any result will be accurate.
          </li>
          <li>
            This is v1 software handling real money. Use amounts you can afford to lose.
          </li>
        </ol>
      </Section>

      <Section id="liability" heading="Liability" numbered>
        <ol className="doc-sub">
          <li>
            To the fullest extent the law allows, we are not liable for indirect, incidental,
            special or consequential loss, or for lost profits, revenue, data or opportunity.
          </li>
          <li>
            We are specifically not liable for: funds lost because you lost your passphrase;
            funds sent to an address that is not yours; a third-party service&apos;s output,
            failure, or conduct; blockchain, network or infrastructure failure; or the value
            of any digital asset.
          </li>
          <li>
            Funds you send to your own agent address on a network Trident does not currently
            operate on are not lost, because the same key controls that address on every EVM
            chain. We do not undertake to retrieve them for you, and we are not liable if a
            network never becomes reachable through the product.
          </li>
          <li>
            Where liability cannot lawfully be excluded, it is limited to the total fees you
            have paid us, which is currently nothing.
          </li>
          <li>
            Nothing here excludes liability for fraud, or for anything else that cannot be
            excluded by law.
          </li>
        </ol>
      </Section>

      <Section id="ending" heading="Ending it" numbered>
        <ol className="doc-sub">
          <li>
            You can stop using Trident and delete your account whenever you like.{' '}
            <strong>Withdraw your funds first.</strong> Deleting the account deletes the
            encrypted key, and we cannot recover it afterwards.
          </li>
          <li>
            We may suspend or end your access for a breach of these terms, or if we are
            required to.
          </li>
          <li>
            We may discontinue Trident. If we do, we will give reasonable notice so you can
            withdraw.
          </li>
          <li>Clauses 9 through 13 survive the end of this agreement.</li>
        </ol>
      </Section>

      <Section id="changes" heading="Changes" numbered>
        <ol className="doc-sub">
          <li>
            We may update these terms. The date at the top changes, and material changes are
            announced in the app before taking effect.
          </li>
          <li>Continuing to use Trident after a change means you accept it.</li>
          <li>
            Every past version is in the{' '}
            <a
              className="doc-a"
              href="https://github.com/Anazodo-C/trident-agent"
              target="_blank"
              rel="noreferrer noopener"
            >
              public repository&apos;s history
            </a>
            .
          </li>
        </ol>
      </Section>

      <Section id="law" heading="General" numbered>
        <ol className="doc-sub">
          <li>If any clause is unenforceable, the rest stands.</li>
          <li>
            These terms are the whole agreement between you and us about Trident, and they
            replace anything said elsewhere about it.
          </li>
          <li>
            Questions go to{' '}
            <a
              className="doc-a"
              href="https://x.com/tridentagent"
              target="_blank"
              rel="noreferrer noopener"
            >
              x.com/tridentagent
            </a>
            .
          </li>
        </ol>
      </Section>
    </ContentPage>
  )
}
