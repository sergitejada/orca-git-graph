import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { readActiveRepo } from './focus.js'
import type { HistoryRequest } from './types.js'

export const HISTORY_PAGE = 250
export const HISTORY_MAX = 5000
export const HISTORY_TARGETS = 32
const statePath = fileURLToPath(new URL('./history.state.json', import.meta.url))
const requestPath = fileURLToPath(new URL('./history.request.json', import.meta.url))

export interface HistoryState {
  repo: string
  session: string
  limit: number
  targets: string[]
  focus?: string
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value))
  await rename(temporary, path)
}

export async function resetHistory(repo = ''): Promise<HistoryState> {
  const state = { repo, session: randomUUID(), limit: HISTORY_PAGE, targets: [] }
  await atomicJson(statePath, state)
  return state
}

export async function readHistory(repo: string): Promise<HistoryState> {
  const state = await storedHistory()
  if (!state) return resetHistory(repo)
  if (state.repo !== repo) throw new Error('La sesión del historial ha cambiado.')
  return state
}

export async function storedHistory(): Promise<HistoryState | null> {
  return JSON.parse(await readFile(statePath, 'utf8').catch(() => 'null')) as HistoryState | null
}

// Idempotent requests: repeated clicks from the same rendered range load one page.
export function applyHistoryRequest(state: HistoryState, request: HistoryRequest): HistoryState {
  if (!request || typeof request.session !== 'string' || !request.session || !Number.isInteger(request.limit)
    || request.limit < HISTORY_PAGE || request.limit > HISTORY_MAX || request.limit % HISTORY_PAGE !== 0) throw new Error('Solicitud de historial inválida.')
  if (request.session !== state.session || request.limit !== state.limit) return state
  if (request.target !== undefined) {
    if (typeof request.target !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.target)) throw new Error('Hash de padre inválido.')
    if (state.targets.includes(request.target)) return state
    if (state.targets.length >= HISTORY_TARGETS) throw new Error('Límite de 32 padres adicionales. Carga anteriores para ampliar el rango.')
    return { ...state, targets: [...state.targets, request.target], focus: request.target }
  }
  if (state.limit >= HISTORY_MAX) return state
  return { ...state, limit: Math.min(HISTORY_MAX, state.limit + HISTORY_PAGE), focus: undefined }
}

export async function consumeHistoryRequest(repo: string): Promise<HistoryState> {
  const state = await readHistory(repo)
  const request = JSON.parse(await readFile(requestPath, 'utf8').catch(() => 'null')) as HistoryRequest | null
  if (!request) return state
  const next = applyHistoryRequest(state, request)
  if (next !== state) await atomicJson(statePath, next)
  return next
}

// The terminal submits a mailbox request; only the worker renders the new range.
export async function runHistoryAction(repo: string, request: HistoryRequest, readSelection: () => Promise<string | null> = readActiveRepo): Promise<void> {
  if (await readSelection() !== repo) throw new Error('El repositorio seleccionado ha cambiado.')
  const state = await storedHistory()
  if (!state || state.repo !== repo || state.session !== request.session || state.limit !== request.limit) throw new Error('El historial ha cambiado. Reabre la acción.')
  applyHistoryRequest(state, request)
  if (await readSelection() !== repo) throw new Error('El repositorio seleccionado ha cambiado.')
  await atomicJson(requestPath, request)
  console.log('Solicitud enviada. El worker actualizará el historial en el próximo refresco.')
}
