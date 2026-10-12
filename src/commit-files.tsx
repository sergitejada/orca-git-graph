import { useState } from 'react'
import type { CommitComparison } from './types.js'

const states: Record<string, string> = { A: 'Añadido', M: 'Modificado', D: 'Eliminado', R: 'Renombrado', C: 'Copiado', T: 'Tipo cambiado' }

export function CommitFiles({ comparisons = [], notice }: { comparisons?: CommitComparison[]; notice?: string }) {
  const [selected, setSelected] = useState(0)
  const comparison = comparisons[selected] || comparisons[0]
  return <section className="commit-files" aria-label="Archivos y diff">
    <h4>Archivos y diff</h4>
    {comparisons.length > 1 ? <label className="diff-comparison">Comparar con
      <select aria-label="Comparación del diff" value={selected} onChange={event => setSelected(Number(event.target.value))}>
        {comparisons.map((item, index) => <option key={`${item.base}-${item.target}`} value={index}>{item.label}</option>)}
      </select>
    </label> : comparison ? <p className="detail-muted">{comparison.label}</p> : null}
    {notice ? <p className="diff-notice" role="status">{notice}</p> : null}
    {comparison ? <div key={`${comparison.base}-${comparison.target}`}>
      <p className="detail-muted">Base: <code>{comparison.base || 'árbol vacío'}</code><br />Destino: <code>{comparison.target}</code></p>
      {comparison.notice ? <p className="diff-notice" role="status">{comparison.notice}</p> : null}
      <p className="detail-muted">{comparison.files.length} archivos incluidos · abre un archivo para ver su diff</p>
      {!comparison.files.length && !comparison.notice ? <p>Sin cambios en esta comparación.</p> : null}
      {comparison.files.map(file => <details className="commit-file" key={file.path}>
        <summary title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`}>
          <span className={`diff-state diff-state-${file.status[0]}`}>{states[file.status[0]] || file.status}</span>{' '}
          <span className="diff-path">{file.oldPath ? <>{file.oldPath} → </> : null}{file.path}</span>
        </summary>
        {file.binary ? <p className="detail-muted">Archivo binario: no se muestra un diff de texto.</p> : null}
        {file.notice ? <p className="diff-notice" role="status">{file.notice}</p> : null}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded patch scroll area must support keyboard scrolling. */}
        {!file.binary && file.patch ? <section className="file-patch" tabIndex={0} aria-label={`Diff de ${file.path}`}><pre>{file.patch.split('\n').map((line, index) =>
          <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-deleted' : line.startsWith('@@') ? 'diff-hunk' : undefined}>{line}{'\n'}</span>)}</pre></section> : null}
      </details>)}
    </div> : !notice ? <p className="detail-muted">La comparación no está incluida en estos datos del panel.</p> : null}
  </section>
}
