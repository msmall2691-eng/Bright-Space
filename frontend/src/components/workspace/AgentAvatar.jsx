/** Emoji avatar in a circle tinted with the agent's own persona color (from
 *  its YAML config, served by GET /api/agents). Falls back to a neutral
 *  gray circle with a "?" when no agent is passed (e.g. "Auto" mode). */
export default function AgentAvatar({ agent, size = 'md', ring = false }) {
  const sizes = {
    sm: 'w-7 h-7 text-[13px]',
    md: 'w-9 h-9 text-base',
    lg: 'w-12 h-12 text-xl',
  }
  const color = agent?.color || '#6b7280'
  return (
    <span
      className={`bb-icon-chip grid place-items-center rounded-full shrink-0 ${sizes[size]} ${ring ? 'ring-2 ring-offset-2 ring-offset-panel' : ''}`}
      style={{
        backgroundColor: `${color}1f`,
        color,
        ...(ring ? { '--tw-ring-color': color } : {}),
      }}
    >
      {agent?.emoji || '🤖'}
    </span>
  )
}
