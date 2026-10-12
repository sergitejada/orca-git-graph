// Protocolo público del panel de Orca; el iframe tiene origen opaco.
let sequence = 0
export function callHost<T>(action: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = `git-graph-${Date.now()}-${++sequence}`
    const finish = () => { window.clearTimeout(timer); window.removeEventListener('message', receive) }
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'orca-panel-action-result' || event.data.requestId !== requestId) return
      finish()
      if (event.data.ok) resolve(event.data.value as T)
      else reject(new Error(event.data.error || 'Orca no pudo ejecutar la acción.'))
    }
    const timer = window.setTimeout(() => { finish(); reject(new Error('Orca no responde. Recarga el plugin y revisa sus permisos.')) }, 10000)
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'orca-panel-action', requestId, action, params }, '*')
  })
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const input = document.createElement('textarea')
    input.value = text
    input.style.cssText = 'position:fixed;left:0;top:0;opacity:0'
    document.body.appendChild(input)
    input.select()
    let copied = false
    try { copied = document.execCommand('copy') } finally { input.remove() }
    if (!copied) throw new Error('No se pudo copiar. Selecciona el texto y pulsa Ctrl+C.')
  }
}
