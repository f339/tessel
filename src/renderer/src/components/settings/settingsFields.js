// Settings: the number fields and sliders several pages share (Appearance, Terminal).
import { settings, limitNumber } from '../../settings'

// A number setting typed in a field: kept in its range (Orca's), shown back.
export function setNumber(key, e, round = false) {
  const v = limitNumber(key, parseFloat(e.target.value))
  if (v !== null) settings[key] = round ? Math.round(v) : Math.round(v * 100) / 100
  e.target.value = settings[key]
}
export function setRange(key, e) {
  const v = limitNumber(key, parseFloat(e.target.value))
  if (v !== null) settings[key] = Math.round(v * 100) / 100
}
