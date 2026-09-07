/**
 * The office looking at one cleaner's app.
 *
 * WHY IT RENDERS THE REAL SCREEN. The whole value is that what the office sees
 * is what the cleaner sees — a mock-up would reassure you about a screen that
 * no longer exists. So this mounts `MyDay` itself, against
 * GET /api/crew/preview/{id}/my-day, which calls the same `my_day` the
 * cleaner's own request calls.
 *
 * READ-ONLY, IN TWO PLACES, and the backend one is the real guarantee. Every
 * mutating /api/crew route is `Depends(require_role("cleaner"))` and
 * `require_role` is a strict membership test with no admin bypass, so an
 * office session is refused whatever this page renders. MyDay's preview mode
 * then blocks the writes locally so the screen explains itself instead of
 * showing a 403.
 *
 * That is not fussiness. An office user tapping "Accept" for a subcontractor
 * would be ASSIGNING them work, and a sub requests or accepts and is never
 * assigned (brightbase-marketplace, Rule 0) — worker classification, not
 * etiquette.
 *
 * The buttons stay visible deliberately: a screen with its actions stripped
 * out is not the screen you came to look at.
 */
import { useParams } from 'react-router-dom'
import MyDay from './MyDay'

export default function CrewAppPreview() {
  const { userId } = useParams()
  const id = Number(userId)

  if (!Number.isFinite(id) || id <= 0) {
    return (
      <div className="max-w-lg px-4 py-10 sm:px-8">
        <p className="text-[13px] text-ink-2">
          That isn’t a cleaner I can show you.{' '}
          <a href="/crew" className="text-ink underline underline-offset-2 hover:text-indigo-600">
            Back to Crew
          </a>
        </p>
      </div>
    )
  }
  // The office shell already provides the frame; MyDay brings its own layout.
  return <MyDay previewUserId={id} />
}
