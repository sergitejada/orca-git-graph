# Git Graph para Orca

Plugin de [Orca](https://github.com/stablyai/orca) que añade a la sidebar derecha, junto a Ficheros, Source Control y PRs, el grafo de commits y ramas del worktree, al estilo de la extensión Git Graph de VS Code.

- Tabla con columnas Grafo, Descripción, Fecha, Autor y Commit. En una sidebar estrecha se ocultan Autor, Fecha y Commit, en ese orden.
- Carriles con la paleta de Git Graph y curvas donde una rama sale o se fusiona.
- Fila **Cambios sin confirmar (N)** arriba, unida a HEAD con una línea gris.
- Etiquetas de rama y tag con icono; la remota del mismo nombre va dentro de la etiqueta local (`main | origin`).
- Al pasar el ratón: hash completo, autor, fecha y mensaje; en los cambios sin confirmar, los ficheros.
- Botón **Pantalla completa** en la cabecera para ampliar el grafo; `Esc` permite salir.
- Muestra ramas locales, remotas, tags y HEAD (`git log --branches --remotes --tags HEAD`), sin refs internas como checkpoints de agentes.
- Búsqueda por mensaje completo, autor, email, hash, refs y rutas sin confirmar. `/` enfoca el buscador.
- Filtros por rama, autor y merges; la rama incluye sus antepasados dentro del historial cargado. Los commits que no coinciden se atenúan para conservar las conexiones reales del grafo.
- Selector de ramas siempre visible, con búsqueda de ramas locales y remotas y la opción **Todas las ramas**. Se puede usar con `↑`/`↓`, `Enter` y `Esc`.
- Selección de commits con detalles: mensaje completo, autor, fecha, hash copiable y navegación a sus padres.
- Detalles de los cambios sin confirmar, con todos los ficheros y su estado.
- El repositorio sigue al proyecto y worktree seleccionados en Orca, aunque no haya agentes trabajando.
- **Ir a HEAD**, navegación entre coincidencias con los botones o `↑`/`↓`, y `Esc` para cerrar los detalles.

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
| `src/build.ts` | Comprueba TypeScript en modo estricto y compila `main.mjs` y `render.mjs`. Los bundles incluyen React y los assets del navegador. Los `.mjs` de la raíz se generan; se editan los fuentes de `src/`. |
| `panel.html` | HTML generado con el render inicial, los datos serializados, el CSS y el bundle React inline. El worker lo marca como `skip-worktree`. |

Orca carga los paneles mediante `srcdoc`, con una CSP que solo permite scripts y estilos inline. Por eso el panel no usa enlaces a JS/CSS locales ni una CDN. `render.mjs` es también la entrada compilada para generar el panel desde la terminal.

El worktree mostrado es el **seleccionado en Orca**. Como la API pública de plugins todavía no devuelve su ruta, el worker lee el perfil activo de Orca en modo de solo lectura (`profile-state.db`, o `orca-data.json` en versiones anteriores). Recupera la selección al arrancar, sin depender del último agente activo. Si solo hay un proyecto seleccionado, utiliza su repositorio principal. La actividad de agentes en otros proyectos no cambia el repositorio mostrado. Las actualizaciones pendientes se descartan si cambia la selección antes de escribir el panel.

## Limitaciones

- **Solo funciona como plugin en desarrollo.** Los plugins instalados desde un marketplace viven en una carpeta inmutable que Orca verifica por hash, y este plugin necesita reescribir su `panel.html`. Mientras la API de plugins no deje al panel recibir datos del worker, no se puede publicar en un marketplace.
- Si Orca cierra el worker por inactividad, el grafo se actualiza con la siguiente actividad de un agente o con **Git Graph: Refrescar**.
- Muestra los últimos 250 commits.
- La detección del foco depende del formato del estado local de Orca y podría necesitar adaptación si este cambia. Usa la carpeta de datos habitual de Orca o `ORCA_USER_DATA_PATH` cuando está disponible. Los worktrees remotos no se renderizan con el Git local; se vacía el panel al seleccionarlos.
- La búsqueda y los filtros operan sobre esos commits cargados. La copia del hash ofrece selección manual si el iframe bloquea el portapapeles.

## Desarrollo

```bash
npm install
npm run build                # comprueba los tipos y compila TypeScript/React
npm run typecheck            # solo comprueba los tipos
npm test                     # recompila y ejecuta los tests del grafo/HTML
npm run test:browser         # iframe sandbox + CSP, estilos e hidratación (Edge)
node render.mjs <repo>       # genera panel.html para un repo concreto
node render.mjs --reset      # deja panel.html vacío
```

El worker marca `panel.html` como `skip-worktree` automáticamente antes de actualizarlo, así Git no lo muestra ni lo incluye en commits normales.

Después de recompilar, recarga el plugin en Orca para reiniciar el worker con el nuevo bundle. La prueba de navegador usa Edge instalado; se puede seleccionar otro Chromium con `PLAYWRIGHT_BROWSER_CHANNEL` o `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Su captura queda en `test-artifacts/`.

## Licencia

MIT
