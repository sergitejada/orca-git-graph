# Git Graph para Orca

Plugin de [Orca](https://github.com/stablyai/orca) que añade a la sidebar derecha, junto a Ficheros, Source Control y PRs, el grafo de commits y ramas del worktree, al estilo de la extensión Git Graph de VS Code.

- Tabla con columnas Grafo, Descripción, Fecha, Autor y Commit. En una sidebar estrecha se ocultan Autor, Fecha y Commit, en ese orden.
- Carriles con la paleta de Git Graph y curvas donde una rama sale o se fusiona.
- Fila **Cambios sin confirmar (N)** arriba, unida a HEAD con una línea gris.
- Los repositorios recién inicializados muestran su rama simbólica y un aviso de que aún no tiene commits. Los archivos sin seguimiento o preparados para el primer commit aparecen en **Cambios sin confirmar**, sin conexión a un HEAD inexistente; un repositorio vacío muestra que no hay archivos pendientes. Tras el primer commit, el siguiente refresco muestra el historial habitual. Las rutas que no son repositorios y los errores de Git siguen mostrando un error.
- Stashes existentes con etiqueta `stash@{n}`, icono y mensaje, unidos a su commit base sin mostrar los snapshots internos del índice. Se pueden buscar, filtrar y seleccionar para ver sus detalles.
- Al hacer clic derecho sobre la etiqueta del stash (o `Shift+F10` con la etiqueta enfocada): menú para aplicar, crear rama, aplicar y eliminar (pop), eliminar (drop), copiar nombre o copiar hash. El clic izquierdo en la fila abre sus detalles. Las acciones de Git se ejecutan en una terminal de shell elegida por el usuario, con Node y Git en el PATH; el resultado se muestra en esa terminal. Orca requiere los permisos `workspace:read` y `terminal:send`.
- Etiquetas de rama y tag con icono; la remota del mismo nombre va dentro de la etiqueta local (`main | origin`).
- Al pasar el ratón: hash completo, autor, fecha y mensaje; en los cambios sin confirmar, los ficheros.
- Botón **Pantalla completa** en la cabecera para ampliar el grafo; `Esc` permite salir.
- Muestra ramas locales, remotas, tags y HEAD (`git log --branches --remotes --tags HEAD`), sin refs internas como checkpoints de agentes.
- Botones con iconos de nube y flecha circular en la cabecera: **Fetch from remote** ejecuta `git fetch --all` y actualiza el grafo; **Refrescar grafo** vuelve a leer Git. Ambos piden una terminal de shell libre en Orca, con Node y Git en el PATH, y muestran el resultado en esa terminal. Comprueban la selección antes de actuar y descartan el panel si cambia mientras se ejecutan. Usan los permisos existentes `workspace:read` y `terminal:send`, porque el bridge del panel no permite invocar comandos del worker.
- Búsqueda por mensaje completo, autor, email, hash, refs y rutas sin confirmar. La lupa abre el buscador; `/` lo abre y enfoca. El botón **Cerrar búsqueda** lo oculta, limpia el texto y devuelve el foco a la lupa.
- Icono **Opciones del grafo** junto a la lupa, con **Mostrar ramas remotas** y **Mostrar stashes**, activadas inicialmente. Ocultar remotas elimina sus etiquetas, entradas del selector e historial exclusivo; conserva los commits compartidos con HEAD, ramas locales, tags o stashes visibles. Ocultar stashes elimina sus filas y cierra sus detalles si estaban abiertos. El grafo se recalcula conservando los padres reales. Las opciones se aplican al panel abierto.
- La lupa y el icono de filtros están junto a fetch y refresh en la cabecera. Filtros por rama, autor y merges; la rama incluye sus antepasados dentro del historial cargado. Los commits que no coinciden se atenúan para conservar las conexiones reales del grafo. Un punto en el icono indica que hay filtros activos.
- Selector de ramas siempre visible, con búsqueda de ramas locales y remotas y la opción **Todas las ramas**. Se puede usar con `↑`/`↓`, `Enter` y `Esc`.
- Relación de la rama actual con su upstream: nombre y commits **ahead** (por delante) / **behind** (por detrás), incluidos los ceros, con etiquetas accesibles y disposición adaptable a sidebar estrecha. Compara el historial completo usando las refs locales disponibles, actualizadas por fetch; leer el estado no ejecuta fetch automáticamente. Indica sin upstream, upstream desaparecido de las refs locales, HEAD separado o repositorio sin commits. Si no se puede calcular la comparación, lo indica sin inventar contadores. No añade acciones pull/push.
- Selección de commits con detalles en un panel inferior de altura ajustable: mensaje completo, autor, fecha, hash copiable y navegación a sus padres. Arrastra el separador o enfócalo y usa `↑`/`↓` para ajustar la altura; `Home`/`End` llevan al mínimo/máximo. El historial y los detalles tienen scroll independiente.
- **Archivos y diff** en los detalles: lista de archivos modificados con su estado, rutas originales de renombrados y diff unificado plegable por archivo (abre con `Enter` o espacio). Los commits raíz se comparan con el árbol vacío; en merges se elige explícitamente el padre (hasta 4). Los stashes ofrecen cambios de trabajo respecto a la base, índice respecto a la base y archivos sin seguimiento cuando existen. Los binarios muestran un aviso y los submódulos sus cambios de referencia.
- Detalles de los cambios sin confirmar con iconos de archivo y nombres coloreados por estado: verde para añadidos o sin seguimiento, amarillo para modificados, rojo para eliminados, turquesa para renombrados y rosa para conflictos. El estado y la ruta completa aparecen al pasar el ratón. Botones a la derecha alternan entre árbol de carpetas plegables (vista inicial) y lista de rutas completas.
- El repositorio sigue al proyecto y worktree seleccionados en Orca, aunque no haya agentes trabajando.
- **Estado del panel** permite copiar una instantánea y restaurarla pegándola tras una actualización: búsqueda, filtros, opciones del grafo, vista árbol/lista, commit seleccionado, foco, scroll de historial y detalles y altura del separador. La restauración exige la misma ruta de repositorio/worktree; descarta commits, ramas y autores que ya no están cargados. El foco vuelve al control o fila guardados, o a HEAD/la primera fila si desaparecieron. La instantánea contiene la ruta local y el texto de búsqueda: guárdala en un lugar privado.
- Icono de diana **Ir a HEAD** junto a fetch, refresh, búsqueda y filtros. La cabecera muestra la hora de actualización sin contadores de commits o stashes. Navegación entre coincidencias con `↑`/`↓` desde las filas del historial, y `Esc` para cerrar los detalles.

## Requisitos

- Orca 1.4 o posterior, con el sistema de plugins activado.
- Node 22.13 o posterior y `git` en el `PATH`. El worker usa el Node incluido en Orca (la versión 1.4.224 incluye Node 24).

## Instalación

El plugin se instala como **plugin en desarrollo**: Orca lo carga desde una carpeta tuya.

```bash
git clone https://github.com/<usuario>/orca-git-graph.git
```

1. En Orca, abre **Ajustes → Plugins** y activa el sistema de plugins.
2. Instala las dependencias y compila el panel: `npm install` y `npm run build`.
3. Añade la carpeta clonada a las rutas de plugins en desarrollo.
4. Acepta los permisos del plugin (`storage` y `events:subscribe`). El grafo se refresca cuando hay actividad.
5. Abre el icono **Git Graph** (`activity`) en la barra de la sidebar derecha.

## Cómo funciona

Un panel de plugin en Orca es un iframe aislado: no tiene red ni acceso a git. Por eso el trabajo se reparte así:

| Pieza | Qué hace |
| --- | --- |
| `src/main.ts` / `src/focus.ts` | Worker del plugin (Node), compilado a `main.mjs`. Comprueba la selección de Orca cada segundo y cambia el repo al cambiar de proyecto o worktree. Refresca Git cada 4 s, con actividad o con **Git Graph: Refrescar**. |
| `src/render.ts` | Ejecuta Git, calcula los carriles y renderiza React en el servidor. Compara tanto el HTML como los datos ignorando el reloj, para evitar recargas sin cambios. |
| `src/panel.tsx` | Componentes React tipados para la tabla, las etiquetas, el grafo SVG y pantalla completa. `src/panel.css` contiene los estilos y `src/client.tsx` hidrata la vista. |
| `src/explore.ts` / `src/details.tsx` | Búsqueda y recorrido de ramas, filtros y panel de detalles. |
| `src/types.ts` | Tipos compartidos de commits, cambios, carriles y datos del panel. |
| `src/build.ts` | Comprueba TypeScript en modo estricto, compila `main.mjs` y `render.mjs` y actualiza el panel local con la selección de Orca. Publica los bundles completos para que el worker no lea archivos a medio escribir. Los `.mjs` de la raíz se generan; se editan los fuentes de `src/`. |
| `panel.html` | HTML generado con el render inicial, los datos serializados, el CSS y el bundle React inline. El worker lo marca como `skip-worktree`. |

Orca carga los paneles mediante `srcdoc`, con una CSP que solo permite scripts y estilos inline. Por eso el panel no usa enlaces a JS/CSS locales ni una CDN. `render.mjs` es también la entrada compilada para generar el panel desde la terminal.

El worktree mostrado es el **seleccionado en Orca**. Como la API pública de plugins todavía no devuelve su ruta, el worker lee el perfil activo de Orca en modo de solo lectura (`profile-state.db`, o `orca-data.json` en versiones anteriores). Recupera la selección al arrancar, sin depender del último agente activo. Si solo hay un proyecto seleccionado, utiliza su repositorio principal. La actividad de agentes en otros proyectos no cambia el repositorio mostrado. Las actualizaciones pendientes se descartan si cambia la selección antes de escribir el panel.

## Limitaciones

- **Solo funciona como plugin en desarrollo.** Los plugins instalados desde un marketplace viven en una carpeta inmutable que Orca verifica por hash, y este plugin necesita reescribir su `panel.html`. Mientras la API de plugins no deje al panel recibir datos del worker, no se puede publicar en un marketplace.
- Si Orca cierra el worker por inactividad, el grafo se actualiza con la siguiente actividad de un agente o con **Git Graph: Refrescar**.
- Muestra los últimos 250 commits.
- La detección del foco depende del formato del estado local de Orca y podría necesitar adaptación si este cambia. Usa la carpeta de datos habitual de Orca o `ORCA_USER_DATA_PATH` cuando está disponible. Los worktrees remotos no se renderizan con el Git local; se vacía el panel al seleccionarlos.
- La búsqueda y los filtros operan sobre esos commits cargados. La copia del hash ofrece selección manual si el iframe bloquea el portapapeles.
- El bridge público de Orca no permite solicitar datos al worker desde el panel. Los archivos y diffs se precargan en Node y se guardan en una caché por ruta del repo, hash y comparación (hasta 1024 entradas), reutilizada en los refrescos de 4 s. Por panel se incluyen como máximo 300 comparaciones y 4 MiB de datos de diff, priorizando el orden del historial. La carga tiene un presupuesto de 15 s: al agotarlo termina la comparación en curso y continúa con las pendientes en el siguiente refresco. Cada comparación tiene un límite de 100 archivos, 64 KiB de metadatos y 64 KiB de patch; cada archivo muestra hasta 16 KiB / 600 líneas. Cada llamada Git tiene un timeout de 5 s y desactiva drivers externos y textconv. La interfaz indica listas/diffs recortados, comparaciones omitidas y errores; un recorte no significa ausencia de cambios. Los errores también se cachean hasta que la comparación sale de la caché o se reinicia el worker. No se ejecuta Git ni se accede a filesystem/red en el iframe, ni se requieren permisos nuevos.
- **La conservación del estado tras actualizar Git es manual.** La API pública actual declara `storage.get/set/delete/keys` con `panel: false`: solo puede usarlos el worker. El bridge permite `workspace.readContext`, `terminal.sendText` y `notifications.show`, pero no enviar el estado al worker. El iframe `sandbox="allow-scripts"` tiene origen opaco: `localStorage`/`sessionStorage` no están disponibles y la CSP bloquea red. Además, Orca reemplaza el iframe completo por cada revisión del HTML, por lo que `window.name`, memoria e historial tampoco sobreviven. No se escribe en el estado interno de Orca ni se envían comandos a terminales para guardar preferencias. El botón de estado ofrece copia manual con `Ctrl+C` si el portapapeles está bloqueado. Copia la instantánea antes de la recarga y pégala después; no hay recuperación automática ni persistencia al reiniciar Orca. Para automatizarlo, Orca debe exponer almacenamiento al panel o un canal público panel/worker. Contratos comprobados: [API pública](https://github.com/stablyai/orca/blob/c43ac3fc3c6c652b7490e69a5fbcaf46a07368f0/src/shared/plugins/plugin-host-api.ts), [iframe y sus revisiones](https://github.com/stablyai/orca/blob/c43ac3fc3c6c652b7490e69a5fbcaf46a07368f0/src/renderer/src/components/right-sidebar/PluginPanel.tsx) y [CSP](https://github.com/stablyai/orca/blob/c43ac3fc3c6c652b7490e69a5fbcaf46a07368f0/src/shared/plugins/plugin-panel-shell.ts).

## Desarrollo

```bash
npm install
npm run build                # comprueba tipos, compila y actualiza el panel local
npm run typecheck            # solo comprueba los tipos
npm run lint                 # analiza el código con Biome; falla también con avisos
npm run lint:fix             # aplica las correcciones seguras del linter
npm test                     # recompila y ejecuta los tests del grafo/HTML
npm run test:browser         # iframe sandbox + CSP, estilos e hidratación (Edge)
node render.mjs <repo>       # genera panel.html para un repo concreto
node render.mjs --reset      # deja panel.html vacío
```

El worker marca `panel.html` como `skip-worktree` automáticamente antes de actualizarlo, así Git no lo muestra ni lo incluye en commits normales.

El repositorio usa pnpm: instala las dependencias con `pnpm install` y ejecuta los scripts con `pnpm run <script>` (por ejemplo, `pnpm run lint`).

El linter usa [Biome](https://biomejs.dev/linter/), configurado en `biome.json`, y respeta `.gitignore`. Se excluyen los bundles, el HTML generado y las skills. `lint` exige que no haya errores ni avisos. La configuración del formatter conserva las comillas simples, los dos espacios de indentación y la ausencia de punto y coma. La comprobación de dependencias tiene una excepción en `src/render.ts` porque `panel-assets` es un módulo virtual creado por esbuild. Las opciones del selector de ramas tienen excepciones locales documentadas: el foco y el teclado se gestionan en el combobox mediante `aria-activedescendant`. `lint:fix` aplica solo correcciones seguras del linter, sin reformatear ni organizar imports.

`pnpm run build` actualiza el HTML del panel al terminar. El worker carga `render.mjs` por una revisión de su contenido y detecta las nuevas compilaciones en el siguiente refresco (hasta 4 s), sin restaurar la interfaz anterior ni crear otro worker. Los cambios en componentes, estilos y lógica del renderizador no necesitan desactivar y activar el plugin. Los cambios en el propio worker (`src/main.ts` o `src/focus.ts`) sí requieren recargarlo en Orca; también hace falta una recarga al instalar por primera vez esta versión con recarga del renderizador. `pnpm test` compila sin actualizar el panel local. Si el perfil de Orca no está disponible, la compilación termina con un aviso y el worker actualiza el panel cuando puede leer la selección.

La prueba de navegador usa Edge instalado; se puede seleccionar otro Chromium con `PLAYWRIGHT_BROWSER_CHANNEL` o `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Su captura queda en `test-artifacts/`.

## Licencia

MIT
