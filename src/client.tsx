import { hydrateRoot } from 'react-dom/client'
import { Panel } from './panel.js'
import type { PanelData } from './types.js'
import './panel.css'

const root = document.getElementById('root')
const data = document.getElementById('git-graph-data')?.textContent
if (!root || !data) throw new Error('Faltan los datos iniciales de Git Graph')
hydrateRoot(root, <Panel {...JSON.parse(data) as PanelData} />)
