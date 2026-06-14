import { useState, useEffect, useCallback } from 'react'
import { get, post, patch, del } from '../api'

/**
 * Saved views for a list page (Twenty's "views"): the current user's named
 * presets of a page's filters/sort/columns for one entity type. The `config`
 * blob is whatever the page wants to persist — the backend treats it as opaque.
 *
 * Returns the views plus create/update/delete helpers that keep the list fresh.
 */
export function useSavedViews(entityType) {
  const [views, setViews] = useState([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(() => {
    if (!entityType) return Promise.resolve([])
    return get(`/api/views?entity_type=${encodeURIComponent(entityType)}`)
      .then(rows => { setViews(rows); return rows })
      .catch(err => { console.error('[useSavedViews]', err); return [] })
      .finally(() => setLoaded(true))
  }, [entityType])

  useEffect(() => { reload() }, [reload])

  const createView = useCallback((name, config, isDefault = false) =>
    post('/api/views', { entity_type: entityType, name, config, is_default: isDefault })
      .then(v => reload().then(() => v)), [entityType, reload])

  const updateView = useCallback((id, body) =>
    patch(`/api/views/${id}`, body).then(v => reload().then(() => v)), [reload])

  const deleteView = useCallback((id) =>
    del(`/api/views/${id}`).then(() => reload()), [reload])

  return { views, loaded, reload, createView, updateView, deleteView }
}
