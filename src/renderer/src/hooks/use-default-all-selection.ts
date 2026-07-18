import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function sameSelection(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...right].every((key) => left.has(key))
}

/**
 * A test group starts with every available item selected. User deselections are
 * retained while that same group is refreshed, while switching groups resets
 * the new group to the default-all state.
 */
export function useDefaultAllSelection(
  scopeKey: string | undefined,
  availableKeys: readonly string[]
): {
  selected: Set<string>
  setItemSelected: (key: string, selected: boolean) => void
  setAllSelected: (selected: boolean) => void
} {
  const availableSelectionKey = availableKeys.join('\u0000')
  const stableAvailableKeys = useMemo(
    () => (availableSelectionKey ? availableSelectionKey.split('\u0000') : []),
    [availableSelectionKey]
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(availableKeys))
  const deselectedRef = useRef(new Set<string>())
  const previousScopeRef = useRef(scopeKey)
  const initializedRef = useRef(false)

  useEffect(() => {
    const scopeChanged = initializedRef.current && previousScopeRef.current !== scopeKey
    if (!initializedRef.current || scopeChanged) {
      deselectedRef.current.clear()
    }
    initializedRef.current = true
    previousScopeRef.current = scopeKey

    const next = new Set(stableAvailableKeys.filter((key) => !deselectedRef.current.has(key)))
    setSelected((current) => (sameSelection(current, next) ? current : next))
  }, [scopeKey, stableAvailableKeys])

  const setItemSelected = useCallback((key: string, nextSelected: boolean): void => {
    if (nextSelected) deselectedRef.current.delete(key)
    else deselectedRef.current.add(key)

    setSelected((current) => {
      if (current.has(key) === nextSelected) return current
      const next = new Set(current)
      if (nextSelected) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const setAllSelected = useCallback(
    (nextSelected: boolean): void => {
      deselectedRef.current = nextSelected ? new Set() : new Set(stableAvailableKeys)
      const next = nextSelected ? new Set(stableAvailableKeys) : new Set<string>()
      setSelected((current) => (sameSelection(current, next) ? current : next))
    },
    [stableAvailableKeys]
  )

  return useMemo(
    () => ({ selected, setItemSelected, setAllSelected }),
    [selected, setAllSelected, setItemSelected]
  )
}
