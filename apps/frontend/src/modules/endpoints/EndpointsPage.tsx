import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Loader2, RadioTower, Search, ShieldAlert, ShieldCheck } from 'lucide-react'
import { api } from '../../lib/api.ts'
import type { Service, Verification } from '../../lib/types.ts'

const VERIFICATION_UI: Record<
  Verification,
  { label: string; className: string; Icon: typeof ShieldCheck }
> = {
  'verified-x402': {
    label: 'x402 verified',
    className: 'bg-[#00FF88]/10 text-[#00FF88]',
    Icon: ShieldCheck,
  },
  unverified: {
    label: 'unverified',
    className: 'bg-[#FFA040]/10 text-[#FFA040]',
    Icon: ShieldAlert,
  },
  unreachable: {
    label: 'unreachable',
    className: 'bg-[#FF4466]/10 text-[#FF4466]',
    Icon: ShieldAlert,
  },
}

export function EndpointsPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [services, setServices] = useState<Service[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [probing, setProbing] = useState(false)
  const [probed, setProbed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .services(query, category)
        .then((res) => {
          if (cancelled) return
          setServices(res.services)
          setCategories(res.categories)
          setProbed(false)
        })
        .catch(() => undefined)
        .finally(() => !cancelled && setLoading(false))
    }, 200)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, category])

  async function runProbe() {
    setProbing(true)
    try {
      const res = await api.services(query, category, true)
      setServices(res.services)
      setProbed(true)
    } catch {
      /* leave the existing list in place */
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="font-mono text-lg uppercase tracking-widest text-slate-100">Endpoints</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          x402-protected services your agent can pay for. Listings are not proof an endpoint
          is live — run a probe to check the payment handshake before spending.
        </p>
      </header>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
          <input
            className="field pl-9"
            placeholder="Search services…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn-ghost" onClick={runProbe} disabled={probing}>
          {probing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RadioTower className="h-4 w-4" />
          )}
          {probing ? 'Probing' : 'Probe live'}
        </button>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <CategoryChip active={category === ''} onClick={() => setCategory('')}>
          All
        </CategoryChip>
        {categories.map((c) => (
          <CategoryChip key={c} active={category === c} onClick={() => setCategory(c)}>
            {c.replaceAll('_', ' ')}
          </CategoryChip>
        ))}
      </div>

      {probed && (
        <p className="mb-4 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          Live probe complete — statuses below reflect an actual 402 handshake.
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-3 py-12 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
          Loading services
        </div>
      ) : services.length === 0 ? (
        <p className="py-12 text-sm text-slate-500">No services match that search.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              onUse={() =>
                navigate('/app', {
                  state: { prefill: `Use ${service.name} to ` },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
        active
          ? 'border-[#00D4FF]/60 bg-[#00D4FF]/10 text-[#00D4FF]'
          : 'border-[#1A7FFF]/25 text-slate-400 hover:border-[#00D4FF]/40 hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  )
}

function ServiceCard({ service, onUse }: { service: Service; onUse: () => void }) {
  const ui = VERIFICATION_UI[service.verification]
  return (
    <article className="panel-interactive flex flex-col p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="font-mono text-sm text-slate-100">{service.name}</h2>
        <span className={`badge shrink-0 gap-1 ${ui.className}`}>
          <ui.Icon className="h-3 w-3" />
          {ui.label}
        </span>
      </div>

      <p className="mb-4 flex-1 text-sm leading-relaxed text-slate-400">{service.description}</p>

      {service.note && service.verification !== 'verified-x402' && (
        <p className="mb-4 rounded-lg border border-[#FFA040]/30 bg-[#FFA040]/5 p-2.5 text-[11px] leading-relaxed text-[#FFA040]">
          {service.note}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="badge bg-[#1A7FFF]/10 text-[#1A7FFF]">
          {service.category.replaceAll('_', ' ')}
        </span>
        <span className="price text-xs">{service.priceRangeUsdc}</span>
      </div>

      <button className="btn-ghost w-full" onClick={onUse}>
        Use
        <ArrowRight className="h-4 w-4" />
      </button>
    </article>
  )
}
