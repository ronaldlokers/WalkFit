// Weight log: periodic weigh-ins (manual or synced from a health service), persisted
// to localStorage. Pairs with the session history to close the weight-loss feedback
// loop; the newest entry also drives the kcal-estimate weight (see App.vue).
const KEY = 'walkfit.weight.log'
const MAX_ENTRIES = 1000 // years of daily weigh-ins; keeps localStorage bounded

export interface WeightEntry {
  date: string // ISO string, when the weigh-in was taken
  kg: number
  source: string // 'manual' | health-provider id ('withings', ...)
  // provider's stable measurement id (Withings grpid): identifies the same reading
  // across timestamp corrections made in the provider's app (#57). Absent on manual
  // entries and on data synced before this field existed.
  grpid?: number
}

function byDate(a: WeightEntry, b: WeightEntry) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
}

function save(list: WeightEntry[]): WeightEntry[] {
  list.sort(byDate)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

export function loadWeightLog(): WeightEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function addWeighIn(entry: WeightEntry): WeightEntry[] {
  return mergeWeighIns([entry])
}

// Idempotent merge: a provider re-sync never duplicates entries; a matching entry
// overwrites (providers may correct a reading). Matching prefers the provider's stable
// measurement id — a reading whose TIMESTAMP was corrected in the provider's app comes
// back with the same grpid and replaces the stale entry instead of duplicating (#57) —
// and falls back to source+date for manual entries and pre-grpid data.
export function mergeWeighIns(entries: WeightEntry[]): WeightEntry[] {
  const list = loadWeightLog()
  for (const e of entries) {
    let i: number
    if (e.grpid !== undefined) {
      i = list.findIndex((x) => x.source === e.source && x.grpid === e.grpid)
      // adopt a legacy same-date entry (pre-grpid data) — but never one that carries a
      // DIFFERENT grpid: two readings can share a timestamp yet be distinct measurements
      if (i < 0) {
        i = list.findIndex(
          (x) => x.source === e.source && x.grpid === undefined && x.date === e.date,
        )
      }
    } else {
      i = list.findIndex((x) => x.source === e.source && x.date === e.date)
    }
    if (i >= 0) list[i] = e
    else list.push(e)
  }
  return save(list)
}
