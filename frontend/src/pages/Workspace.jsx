/**
 * Workspace — embedded Agent Command Center.
 *
 * Renders the Claude-hosted command-center artifact in an iframe that fills the
 * app's content area, as requested. Heads-up: this is an EXTERNAL embed
 * (claude.site) and is NOT wired to BrightBase's data/agents — the previous
 * in-app agent team (Nova/Mia/Scout/Finn/Pixel/Deploy over websockets) is
 * preserved in git history if we want it back or rebuilt natively later.
 */
const COMMAND_CENTER_EMBED =
  'https://claude.site/public/artifacts/b0f170da-f963-406b-ac04-0a94588cf398/embed'

export default function Workspace() {
  return (
    <div className="h-full w-full bg-bg">
      <iframe
        src={COMMAND_CENTER_EMBED}
        title="Agent Command Center"
        className="w-full h-full border-0"
        allow="clipboard-write"
        allowFullScreen
      />
    </div>
  )
}
