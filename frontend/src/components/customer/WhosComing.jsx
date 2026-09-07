/**
 * "Who's coming" — the crew on a visit, as the customer sees them.
 *
 * SHARED BY BOTH CUSTOMER SURFACES on purpose (the public confirm page and
 * the portal's visit list). Two copies of this would be two places to
 * accidentally add a phone number, a rating, or a "request this cleaner"
 * link — and the last one is the constraint that matters:
 *
 *   A CUSTOMER SEES WHO WON THEIR JOB. THEY NEVER PICK.
 *
 * The office cannot let a customer choose their cleaner, because choosing is
 * assigning and a subcontractor requests or accepts (see
 * `.claude/skills/brightbase-marketplace`). So this component renders names
 * and faces and offers no affordance at all: nothing here is tappable, there
 * is nothing to rate, and there is no way to ask for the same person again.
 * If a future change adds one, it belongs somewhere else and probably
 * nowhere.
 *
 * `photoBase` is the job's public photo path; each face is addressed by its
 * POSITION in `crew`, which is meaningless without that job's token. Photos
 * are lazy and failure is silent — a broken image falls back to initials
 * rather than showing a customer a broken-picture icon on the page where they
 * are deciding whether to let somebody in.
 *
 * COLOR IS INHERITED, never set here. The two hosts run different palettes —
 * the confirm page on the app's `--ink` tokens, the portal on hardcoded slate
 * — and a component that picked one would be invisible on the other the first
 * time a customer's browser was in dark mode. The caller passes its own text
 * color in `className`; everything secondary is an opacity of it.
 */
import { useState } from 'react'

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase()
}

function Face({ person, src }) {
  const [failed, setFailed] = useState(false)
  const showPhoto = person.has_photo && src && !failed
  return (
    <div className="w-11 h-11 rounded-full overflow-hidden bg-black/5 border border-black/10 shrink-0 flex items-center justify-center">
      {showPhoto ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}
          className="w-full h-full object-cover" />
      ) : (
        <span className="text-[15px] font-semibold opacity-50">{initials(person.name)}</span>
      )}
    </div>
  )
}

export default function WhosComing({ crew, photoBase, className = '' }) {
  const people = Array.isArray(crew) ? crew : []
  if (!people.length) return null

  return (
    <div className={className}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-50 mb-2">
        Who's coming
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        {people.map((p, i) => (
          <div key={`${p.name}-${i}`} className="flex items-center gap-2.5">
            <Face person={p} src={photoBase ? `${photoBase}/${i}/photo` : null} />
            <div className="min-w-0">
              <div className="text-sm font-medium">{p.name}</div>
              {p.is_helper && (
                <div className="text-[11px] opacity-50">Helping out</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
