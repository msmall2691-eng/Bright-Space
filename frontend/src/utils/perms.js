/**
 * Role helpers, read from the cached user (same source the list pages use for
 * their inline `canEdit` checks). Mutations are admin/manager-only on the
 * backend, so we hide create/transition actions from viewers/cleaners rather
 * than letting them click into a 403.
 */
export function currentUserRole() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role || null }
  catch { return null }
}

export function canEdit() {
  return ['admin', 'manager'].includes(currentUserRole())
}
