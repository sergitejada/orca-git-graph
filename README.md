# Git Graph para Orca

Plugin de [Orca](https://github.com/stablyai/orca) que añade a la sidebar derecha, junto a Ficheros, Source Control y PRs, el grafo de commits y ramas del worktree, al estilo de la extensión Git Graph de VS Code.

- Tabla con columnas Grafo, Descripción, Fecha, Autor y Commit. En una sidebar estrecha se ocultan Autor, Fecha y Commit, en ese orden.
- Carriles con la paleta de Git Graph y curvas donde una rama sale o se fusiona.
- Fila **Cambios sin confirmar (N)** arriba, unida a HEAD con una línea gris.
- Etiquetas de rama y tag con icono; la remota del mismo nombre va dentro de la etiqueta local (`main | origin`).
- Al pasar el ratón: hash completo, autor, fecha y mensaje; en los cambios sin confirmar, los ficheros.
- Muestra ramas locales, remotas, tags y HEAD (`git log --branches --remotes --tags HEAD`), sin refs internas como checkpoints de agentes.

## Requisitos

- Orca 1.4 o posterior, con el sistema de plugins activado.
- Node 20 o posterior y `git` en el `PATH`.

## Instalación

El plugin se instala como **plugin en desarrollo**: Orca lo carga desde una carpeta tuya.

```bash
git clone https://github.com/<usuario>/orca-git-graph.git
```

1. En Orca, abre **Ajustes → Plugins** y activa el sistema de plugins.
2. Añade la carpeta clonada a las rutas de plugins en desarrollo.
3. Acepta los permisos: `storage`, para recordar el último repo, y `events:subscribe`, para saber cuándo trabaja un agente.
4. Abre el icono **Git Graph** (`activity`) en la barra de la sidebar derecha.

## Cómo funciona

Un panel de plugin en Orca es un iframe aislado: no tiene red ni acceso a git. Por eso el trabajo se reparte así:

| Pieza | Qué hace |
| --- | --- |
| `main.mjs` | El worker del plugin (Node). Orca lo arranca con el primer evento o comando. Sabe qué worktree mostrar por el evento `agent.status.changed`, regenera el grafo cada 4 s mientras sigue vivo y se puede forzar con el comando **Git Graph: Refrescar**. |
| `render.mjs` | Ejecuta `git log`, calcula los carriles y escribe `panel.html` con el grafo en SVG. Solo reescribe el fichero si el grafo cambió. |
| `panel.html` | El panel. Orca lo recarga cuando cambia en disco. |

El worktree mostrado es el del **último agente con actividad**, porque la API de plugins no da la ruta del worktree enfocado. El último repo se guarda y se recupera al reiniciar.

## Limitaciones

- **Solo funciona como plugin en desarrollo.** Los plugins instalados desde un marketplace viven en una carpeta inmutable que Orca verifica por hash, y este plugin necesita reescribir su `panel.html`. Mientras la API de plugins no deje al panel recibir datos del worker, no se puede publicar en un marketplace.
- Si Orca cierra el worker por inactividad, el grafo se actualiza con la siguiente actividad de un agente o con **Git Graph: Refrescar**.
- Muestra los últimos 250 commits.

## Desarrollo

```bash
npm test                     # tests del trazado y del HTML (node:test)
node render.mjs <repo>       # genera panel.html para un repo concreto
node render.mjs --reset      # deja panel.html vacío, como se versiona
```

`panel.html` cambia en cuanto usas el plugin. Para que no aparezca en `git status`:

```bash
git update-index --skip-worktree panel.html
```

## Licencia

MIT
