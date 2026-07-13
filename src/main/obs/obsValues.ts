import { ObsSubsystemError } from './errors'

export type UnknownRecord = Record<string, unknown>

export function asRecord(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ObsSubsystemError('OBS_RESPONSE_INVALID', `OBS returned invalid ${context}`)
  }
  return value as UnknownRecord
}

export function requiredString(value: unknown, key: string, context: string): string {
  const record = asRecord(value, context)
  const item = record[key]
  if (typeof item !== 'string' || item.length === 0) {
    throw new ObsSubsystemError('OBS_RESPONSE_INVALID', `OBS ${context} is missing ${key}`)
  }
  return item
}

export function optionalString(value: unknown, key: string): string | null {
  const record = asRecord(value, 'response object')
  const item = record[key]
  return typeof item === 'string' && item.length > 0 ? item : null
}

export function requiredNumber(value: unknown, key: string, context: string): number {
  const record = asRecord(value, context)
  const item = record[key]
  if (typeof item !== 'number' || !Number.isFinite(item)) {
    throw new ObsSubsystemError('OBS_RESPONSE_INVALID', `OBS ${context} is missing ${key}`)
  }
  return item
}

export interface PropertyItem {
  name: string
  value: string
  enabled: boolean
}

export function parsePropertyItems(items: readonly unknown[]): PropertyItem[] {
  const parsed: PropertyItem[] = []
  for (const item of items) {
    const record = asRecord(item, 'property item')
    const name = record.itemName
    const value = record.itemValue
    const enabled = record.itemEnabled
    if (typeof name !== 'string') continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    parsed.push({
      name,
      value: String(value),
      enabled: typeof enabled === 'boolean' ? enabled : true
    })
  }
  return parsed
}
